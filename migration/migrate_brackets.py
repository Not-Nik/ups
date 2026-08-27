#!/usr/bin/env python3
"""Migration: add bracket support and replace the packed `Section` string with its
three parts (StageName / GroupName / RoundName) on an existing db.sqlite3.

It is careful and idempotent:

  * adds the new columns + bracket_nodes table;
  * backfills the three parts FROM Section before removing it, so no information is
    lost (the parts round-trip back to the old Section value);
  * only drops Section once every row is backfilled — otherwise it keeps Section and
    warns, so a malformed row can't silently lose data;
  * re-running is a no-op.

DROP COLUMN needs SQLite >= 3.35 (python -c "import sqlite3; sqlite3.sqlite_version").
Note: the backend still SELECTs Section, so deploy a Section-free backend together
with applying this to prod. Run on a copy first:

    python3 migrate_brackets.py path/to/db.sqlite3      # defaults to db.sqlite3
"""
import sqlite3
import sys

# New columns on `matches`. All nullable so existing rows stay valid; the section
# parts are backfilled below, the rest by load_matches.py on its next run.
NEW_MATCH_COLUMNS = [
    ("ToornamentId", "TEXT"),     # the toornament match/node id (stable join key)
    ("StageType", "TEXT"),        # league / swiss / single_elimination / ...
    ("StageNumber", "INTEGER"),   # toornament stage order (1..N)
    ("StageName", "TEXT"),        # the three parts of the old Section string
    ("GroupName", "TEXT"),
    ("RoundName", "TEXT"),
]

# One row per bracket match (node), including not-yet-decided (TBD) slots. The
# source columns are the edges: opponent X comes from the winner/loser of node Y.
# MatchID links to `matches` only when both teams are known (i.e. predictable).
BRACKET_NODES_DDL = """
CREATE TABLE IF NOT EXISTS bracket_nodes
(
    NodeId      TEXT PRIMARY KEY,
    StageId     TEXT    NOT NULL,
    StageName   TEXT    NOT NULL,
    StageNumber INTEGER NOT NULL,
    StageType   TEXT    NOT NULL,
    GroupName   TEXT    NOT NULL,
    Branch      TEXT,
    RoundNumber INTEGER NOT NULL,
    Position    INTEGER NOT NULL,
    Depth       INTEGER NOT NULL,
    TeamA       TEXT,
    TeamB       TEXT,
    LogoA       TEXT,
    LogoB       TEXT,
    ScoreA      INTEGER,
    ScoreB      INTEGER,
    SourceTypeA TEXT,
    SourceA     TEXT,
    SourceTypeB TEXT,
    SourceB     TEXT,
    MatchID     INTEGER REFERENCES matches (MatchID)
);
"""


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "db.sqlite3"
    con = sqlite3.connect(path)
    cur = con.cursor()

    existing = {row[1] for row in cur.execute("PRAGMA table_info(matches)")}
    for name, col_type in NEW_MATCH_COLUMNS:
        if name in existing:
            print(f"= matches.{name} (already present)")
        else:
            cur.execute(f"ALTER TABLE matches ADD COLUMN {name} {col_type}")
            print(f"+ matches.{name}")

    had_table = cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='bracket_nodes'"
    ).fetchone() is not None
    cur.executescript(BRACKET_NODES_DDL)
    print("= bracket_nodes (already present)" if had_table else "+ bracket_nodes")

    if "Section" not in existing:
        print("= matches.Section (already removed)")
    else:
        # Backfill the parts from Section, then drop it. The last segment is always
        # the round (the day that drives the tabs); a middle segment is the group when
        # present; everything before is the stage (only stage names contain slashes).
        # Some legacy rows have no group (e.g. "Zweite Liga/Seedingwoche") -> group "".
        filled = malformed = 0
        for match_id, section in cur.execute(
            "SELECT MatchID, Section FROM matches WHERE StageName IS NULL"
        ).fetchall():
            parts = section.split("/")
            if len(parts) >= 2:
                stage = "/".join(parts[:-2]) if len(parts) >= 3 else parts[0]
                group = parts[-2] if len(parts) >= 3 else ""
                cur.execute(
                    "UPDATE matches SET StageName = ?, GroupName = ?, RoundName = ? WHERE MatchID = ?",
                    (stage, group, parts[-1], match_id),
                )
                filled += 1
            else:
                malformed += 1
        print(f"section -> parts: {filled} backfilled, {malformed} malformed")

        remaining = cur.execute(
            "SELECT count(*) FROM matches WHERE StageName IS NULL"
        ).fetchone()[0]
        if remaining == 0:
            cur.execute("ALTER TABLE matches DROP COLUMN Section")
            print("- matches.Section (dropped; replaced by StageName/GroupName/RoundName)")
        else:
            print(f"! kept matches.Section: {remaining} row(s) still have NULL parts "
                  "(malformed Section) — investigate before dropping")

    con.commit()
    con.close()
    print(f"done: {path}")


if __name__ == "__main__":
    main()
