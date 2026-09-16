#!/usr/bin/env python3
"""Migration: normalize stage/group/round and team data out of `matches` and
`bracket_nodes` into their own tables, and add `standings`.

  * creates stages, groups, rounds, teams and standings;
  * seeds stages/groups/rounds/teams from toornament for every tournament with a
    ToornamentId, then adds manual rows (ToornamentId NULL) for anything in `matches`
    toornament doesn't know about (e.g. the "Seedingwoche" matches, which have a stage
    but no group);
  * rebuilds `matches` with the same MatchID (predictions reference it), pointing at
    GroupID / RoundID / TeamID instead of copying names and logos;
  * recreates `bracket_nodes` empty in its new shape — the loader refills it.

Everything runs in one transaction: any check that fails rolls the whole thing back.
Re-running on an already migrated db is a no-op.

    python3 migrate_sections.py path/to/db.sqlite3      # defaults to db.sqlite3
"""
import re
import sqlite3
import sys

import requests

BASE_URL = "https://play.toornament.com"

NEW_TABLES_DDL = """
CREATE TABLE stages
(
    StageID      INTEGER PRIMARY KEY,
    TournamentID INTEGER NOT NULL REFERENCES tournaments (TournamentID),
    Number       INTEGER NOT NULL,
    Name         TEXT    NOT NULL,
    Type         TEXT    NOT NULL,
    Status       TEXT,
    ToornamentId TEXT,
    UNIQUE (TournamentID, ToornamentId),
    UNIQUE (TournamentID, Number)
);

CREATE TABLE groups
(
    GroupID      INTEGER PRIMARY KEY,
    StageID      INTEGER NOT NULL REFERENCES stages (StageID) ON DELETE CASCADE,
    Number       INTEGER NOT NULL,
    Name         TEXT    NOT NULL,
    Status       TEXT,
    ToornamentId TEXT,
    UNIQUE (StageID, ToornamentId),
    UNIQUE (StageID, Number)
);

CREATE TABLE rounds
(
    RoundID      INTEGER PRIMARY KEY,
    GroupID      INTEGER NOT NULL REFERENCES groups (GroupID) ON DELETE CASCADE,
    Number       INTEGER NOT NULL,
    Name         TEXT    NOT NULL,
    Status       TEXT,
    ToornamentId TEXT,
    UNIQUE (GroupID, ToornamentId),
    UNIQUE (GroupID, Number)
);

CREATE TABLE teams
(
    TeamID       INTEGER PRIMARY KEY,
    TournamentID INTEGER NOT NULL REFERENCES tournaments (TournamentID),
    Name         TEXT    NOT NULL,
    ShortName    TEXT,
    Logo         TEXT    NOT NULL DEFAULT '',
    ToornamentId TEXT,
    UNIQUE (TournamentID, ToornamentId)
);

CREATE TABLE standings
(
    GroupID      INTEGER NOT NULL REFERENCES groups (GroupID) ON DELETE CASCADE,
    TeamID       INTEGER NOT NULL REFERENCES teams (TeamID),
    Position     INTEGER NOT NULL,
    Rank         INTEGER NOT NULL,
    Points       INTEGER,
    Played       INTEGER NOT NULL DEFAULT 0,
    Wins         INTEGER NOT NULL DEFAULT 0,
    Draws        INTEGER NOT NULL DEFAULT 0,
    Losses       INTEGER NOT NULL DEFAULT 0,
    Forfeits     INTEGER NOT NULL DEFAULT 0,
    ScoreFor     INTEGER,
    ScoreAgainst INTEGER,
    Dropped      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (GroupID, TeamID),
    UNIQUE (GroupID, Position)
);
"""

MATCHES_NEW_DDL = """
CREATE TABLE matches_new
(
    MatchID      INTEGER PRIMARY KEY,
    TournamentID INTEGER NOT NULL REFERENCES tournaments (TournamentID),
    GroupID      INTEGER REFERENCES groups (GroupID),
    RoundID      INTEGER REFERENCES rounds (RoundID),
    TeamA        INTEGER NOT NULL REFERENCES teams (TeamID),
    TeamB        INTEGER NOT NULL REFERENCES teams (TeamID),
    ScoreA       INTEGER,
    ScoreB       INTEGER,
    ToornamentId TEXT
);
"""

BRACKET_NODES_DDL = """
CREATE TABLE bracket_nodes
(
    NodeId       TEXT PRIMARY KEY,
    TournamentID INTEGER NOT NULL REFERENCES tournaments (TournamentID),
    GroupID      INTEGER NOT NULL REFERENCES groups (GroupID),
    RoundID      INTEGER NOT NULL REFERENCES rounds (RoundID),
    Branch       TEXT,
    Position     INTEGER NOT NULL,
    Depth        INTEGER NOT NULL,
    TeamA        INTEGER REFERENCES teams (TeamID),
    TeamB        INTEGER REFERENCES teams (TeamID),
    ScoreA       INTEGER,
    ScoreB       INTEGER,
    SourceTypeA  TEXT,
    SourceA      TEXT,
    SourceTypeB  TEXT,
    SourceB      TEXT,
    MatchID      INTEGER REFERENCES matches (MatchID)
);
"""


class MigrationError(Exception):
    pass


def fetch_items(endpoint, query, page_size):
    """Page through a toornament list endpoint. Each endpoint caps `limit` differently
    (participants 48, stages/rounds 50, matches/groups 100)."""
    items = []
    offset = 0
    while True:
        data = requests.get(
            f"{BASE_URL}/api/{endpoint}?{query}&offset={offset}&limit={page_size}"
        ).json()
        if "items" not in data:
            raise MigrationError(f"{endpoint}?{query}: {data}")
        items += data["items"]
        print(f"  loaded {endpoint} {offset}-{offset + len(data['items'])}")
        if len(data["items"]) < page_size:
            return items
        offset += page_size


def fetch_tournament(toornament_id):
    stages = fetch_items("stages", f"tournament_ids={toornament_id}", 50)
    stage_ids = ",".join(s["id"] for s in stages)
    groups = fetch_items("groups", f"stage_ids={stage_ids}", 100) if stages else []
    rounds = fetch_items("rounds", f"stage_ids={stage_ids}", 50) if stages else []
    participants = fetch_items("participants", f"tournament_ids={toornament_id}", 48)
    matches = fetch_items("matches", f"tournament_ids={toornament_id}", 100)
    return stages, groups, rounds, participants, matches


def participant_logo(participant):
    logo = (participant.get("customFieldValues") or {}).get("logo") or {}
    return (logo.get("icon_medium") or "").strip()


def next_number(cur, sql, parent):
    return cur.execute(sql, (parent,)).fetchone()[0] + 1


def seed_toornament(cur, tournament_id, data):
    """Insert the toornament tree + participants. Returns the toornament id -> local
    id maps needed to rebuild matches."""
    stages, groups, rounds, participants, matches = data
    stage_ids, group_ids, round_ids = {}, {}, {}

    for s in stages:
        stage_ids[s["id"]] = cur.execute(
            "INSERT INTO stages (TournamentID, Number, Name, Type, Status, ToornamentId) "
            "VALUES (?, ?, ?, ?, ?, ?) RETURNING StageID",
            (tournament_id, s["number"], s["name"].strip(), s["type"], s["status"], s["id"]),
        ).fetchone()[0]
    for g in groups:
        group_ids[g["id"]] = cur.execute(
            "INSERT INTO groups (StageID, Number, Name, Status, ToornamentId) "
            "VALUES (?, ?, ?, ?, ?) RETURNING GroupID",
            (stage_ids[g["stage"]["id"]], g["number"], g["name"].strip(), g["status"], g["id"]),
        ).fetchone()[0]
    for r in rounds:
        round_ids[r["id"]] = cur.execute(
            "INSERT INTO rounds (GroupID, Number, Name, Status, ToornamentId) "
            "VALUES (?, ?, ?, ?, ?) RETURNING RoundID",
            (group_ids[r["group"]["id"]], r["number"], r["name"].strip(), r["status"], r["id"]),
        ).fetchone()[0]
    for p in participants:
        cur.execute(
            "INSERT INTO teams (TournamentID, Name, ShortName, Logo, ToornamentId) "
            "VALUES (?, ?, ?, ?, ?)",
            (tournament_id, p["name"].strip(),
             (p.get("customFieldValues") or {}).get("teamkurzel"),
             participant_logo(p), p["id"]),
        )

    # match toornament id -> round toornament id, to place matches in their round
    match_rounds = {m["id"]: m["round"]["id"] for m in matches}
    print(f"  {len(stages)} stages, {len(groups)} groups, {len(rounds)} rounds, "
          f"{len(participants)} teams")
    return round_ids, match_rounds


def find_or_create_stage(cur, tournament_id, name, stage_type):
    row = cur.execute(
        "SELECT StageID FROM stages WHERE TournamentID = ? AND Name = ?", (tournament_id, name)
    ).fetchone()
    if row:
        return row[0]
    number = next_number(
        cur, "SELECT COALESCE(MAX(Number), 0) FROM stages WHERE TournamentID = ?", tournament_id
    )
    print(f"  + manual stage {name!r}")
    return cur.execute(
        "INSERT INTO stages (TournamentID, Number, Name, Type) VALUES (?, ?, ?, ?) "
        "RETURNING StageID",
        (tournament_id, number, name, stage_type or "custom"),
    ).fetchone()[0]


def find_or_create_group(cur, stage_id, name):
    row = cur.execute(
        "SELECT GroupID FROM groups WHERE StageID = ? AND Name = ?", (stage_id, name)
    ).fetchone()
    if row:
        return row[0]
    number = next_number(
        cur, "SELECT COALESCE(MAX(Number), 0) FROM groups WHERE StageID = ?", stage_id
    )
    print(f"  + manual group {name!r} in stage {stage_id}")
    return cur.execute(
        "INSERT INTO groups (StageID, Number, Name) VALUES (?, ?, ?) RETURNING GroupID",
        (stage_id, number, name),
    ).fetchone()[0]


def find_or_create_round(cur, group_id, name):
    # The loader stored league/swiss "Round N" as "Day N"; accept either spelling.
    names = {name, re.sub(r"^Day", "Round", name)}
    for candidate in names:
        row = cur.execute(
            "SELECT RoundID FROM rounds WHERE GroupID = ? AND Name = ?", (group_id, candidate)
        ).fetchone()
        if row:
            return row[0]
    number = next_number(
        cur, "SELECT COALESCE(MAX(Number), 0) FROM rounds WHERE GroupID = ?", group_id
    )
    print(f"  + manual round {name!r} in group {group_id}")
    return cur.execute(
        "INSERT INTO rounds (GroupID, Number, Name) VALUES (?, ?, ?) RETURNING RoundID",
        (group_id, number, name),
    ).fetchone()[0]


def find_or_create_team(cur, tournament_id, name, logo):
    row = cur.execute(
        "SELECT TeamID FROM teams WHERE TournamentID = ? AND Name = ? "
        "ORDER BY ToornamentId IS NULL LIMIT 1",
        (tournament_id, name)
    ).fetchone()
    if row:
        return row[0]
    print(f"  + manual team {name!r} (no toornament participant with that name)")
    return cur.execute(
        "INSERT INTO teams (TournamentID, Name, Logo) VALUES (?, ?, ?) RETURNING TeamID",
        (tournament_id, name, logo or ""),
    ).fetchone()[0]


def rebuild_matches(cur, round_ids, match_rounds):
    cur.execute(MATCHES_NEW_DDL)
    old =cur.execute(
        "SELECT MatchID, TournamentID, TeamA, TeamB, LogoA, LogoB, ScoreA, ScoreB, ToornamentId, "
        "StageType, StageName, GroupName, RoundName FROM matches"
    ).fetchall()

    for (match_id, tournament_id, team_a, team_b, logo_a, logo_b, score_a, score_b,
         toornament_id, stage_type, stage_name, group_name, round_name) in old:
        group_id = round_id = None
        if stage_name:
            stage_id = find_or_create_stage(cur, tournament_id, stage_name, stage_type)
            group_id = find_or_create_group(cur, stage_id, group_name or "")
            toornament_round = match_rounds.get(toornament_id)
            if toornament_round in round_ids:
                round_id = round_ids[toornament_round]
            elif round_name:
                round_id = find_or_create_round(cur, group_id, round_name)

        cur.execute(
            "INSERT INTO matches_new (MatchID, TournamentID, GroupID, RoundID, TeamA, TeamB, "
            "ScoreA, ScoreB, ToornamentId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (match_id, tournament_id, group_id, round_id,
             find_or_create_team(cur, tournament_id, team_a.strip(), logo_a),
             find_or_create_team(cur, tournament_id, team_b.strip(), logo_b),
             score_a, score_b, toornament_id),
        )

    old_count = len(old)
    new_count = cur.execute("SELECT count(*) FROM matches_new").fetchone()[0]
    if new_count != old_count:
        raise MigrationError(f"matches_new has {new_count} rows, matches had {old_count}")
    missing_round = cur.execute(
        "SELECT count(*) FROM matches_new WHERE GroupID IS NOT NULL AND RoundID IS NULL"
    ).fetchone()[0]
    if missing_round:
        raise MigrationError(f"{missing_round} matches have a group but no round")
    print(f"  matches: {new_count} rows rebuilt")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "db.sqlite3"
    con = sqlite3.connect(path, isolation_level=None)
    cur = con.cursor()

    if cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stages'").fetchone():
        print(f"= already migrated: {path}")
        return

    tournaments = cur.execute(
        "SELECT TournamentID, ToornamentId FROM tournaments WHERE ToornamentId IS NOT NULL"
    ).fetchall()
    # Network first, so a toornament hiccup can't leave a half-written transaction open.
    fetched = {}
    for tournament_id, toornament_id in tournaments:
        print(f"fetching tournament {tournament_id} ({toornament_id})")
        fetched[tournament_id] = fetch_tournament(toornament_id)

    cur.execute("BEGIN")
    try:
        # executescript would COMMIT mid-transaction; run the statements one by one instead
        for statement in NEW_TABLES_DDL.split(";"):
            if statement.strip():
                cur.execute(statement)

        round_ids, match_rounds = {}, {}
        for tournament_id, data in fetched.items():
            print(f"seeding tournament {tournament_id}")
            t_rounds, t_match_rounds = seed_toornament(cur, tournament_id, data)
            round_ids.update(t_rounds)
            match_rounds.update(t_match_rounds)

        cur.execute("DROP TABLE bracket_nodes")
        print("rebuilding matches")
        rebuild_matches(cur, round_ids, match_rounds)
        cur.execute("DROP TABLE matches")
        cur.execute("ALTER TABLE matches_new RENAME TO matches")
        cur.execute(BRACKET_NODES_DDL)

        violations = cur.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise MigrationError(f"foreign key violations: {violations[:10]}")
        cur.execute("COMMIT")
    except Exception:
        cur.execute("ROLLBACK")
        raise
    finally:
        con.close()

    print(f"done: {path} (bracket_nodes is empty until the next loader refresh)")


if __name__ == "__main__":
    main()
