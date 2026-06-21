import sys

import requests
import sqlite3

BASE_URL = "https://play.toornament.com"
TOURNAMENT_ID = "2425613637680488447"
MATCHES_URL = f"{BASE_URL}/api/matches?tournament_ids={TOURNAMENT_ID}&"
NODES_URL = f"{BASE_URL}/api/bracket-nodes?stage_ids={{}}"
PAST_MATCHES = "statuses=running,completed&sort=latest_results"
UPCOMING_MATCHES = "statuses=pending&sort=scheduled_asc"

# Stage types played as a bracket rather than a round-robin league. These get a
# row per match (incl. undecided slots) in bracket_nodes so the bracket can be drawn.
BRACKET_TYPES = {"single_elimination", "double_elimination", "bracket_groups"}


class Match:
    def __init__(self, team_a, team_b, logo_a=None, logo_b=None, score_a=None, score_b=None,
                 stage=None, group=None, round=None, number=None,
                 toornament_id=None, stage_type=None, stage_number=None):
        self.team_a = team_a
        self.team_b = team_b
        self.logo_a = logo_a
        self.logo_b = logo_b
        self.score_a = score_a
        self.score_b = score_b
        self.stage = stage
        self.group = group
        self.round = round
        self.number = number
        self.toornament_id = toornament_id
        self.stage_type = stage_type
        self.stage_number = stage_number

    def __repr__(self):
        return str(self.__dict__)


def participant_logo(participant):
    """The team's logo URL (icon_medium) or "" — same source the site already uses."""
    if participant and participant.get("logo"):
        return participant["customFieldValues"]["logo"]["icon_medium"].strip()
    return ""


def fetch_items(url):
    """Page through a toornament list endpoint, returning all items."""
    items = []
    offset = 0
    while True:
        try:
            page = requests.get(url + f"&offset={offset}&limit=100").json()["items"]
        except Exception:
            break
        items += page
        print(f"Loaded {url.split('?')[0].rsplit('/', 1)[-1]} {offset}-{offset + len(page)}")
        if len(page) < 100:
            break
        offset += 100
    return items


def build_match(raw):
    """A Match for the predictable (both teams known) `matches` table, or None."""
    o_a, o_b = raw["opponents"]
    if not o_a["participant"] or not o_b["participant"]:
        return None  # a TBD slot — not predictable; lives only in bracket_nodes
    stage = raw["stage"]
    round_name = raw["round"]["name"].strip()
    if round_name.startswith("Round"):  # league/swiss matchdays read nicer as "Day N"
        round_name = "Day" + round_name.removeprefix("Round")
    return Match(
        team_a=o_a["participant"]["name"].strip(),
        team_b=o_b["participant"]["name"].strip(),
        logo_a=participant_logo(o_a["participant"]),
        logo_b=participant_logo(o_b["participant"]),
        score_a=o_a["score"],
        score_b=o_b["score"],
        stage=stage["name"].strip(),
        group=raw["group"]["name"].strip(),
        round=round_name,
        number=raw["number"],
        toornament_id=raw["id"],
        stage_type=stage["type"],
        stage_number=stage["number"],
    )


def upsert_matches(con, matches):
    """Insert/update league + predictable bracket matches, keyed by the natural
    (TeamA, TeamB, StageName, GroupName, RoundName) key so existing rows (and their
    predictions) are kept; the metadata columns get refreshed on every run."""
    cur = con.cursor()
    for m in matches:
        row = cur.execute(
            "SELECT MatchID FROM matches WHERE TeamA = ? AND TeamB = ? "
            "AND StageName = ? AND GroupName = ? AND RoundName = ?",
            (m.team_a, m.team_b, m.stage, m.group, m.round),
        ).fetchone()
        if row:
            if m.score_a is not None and m.score_b is not None:
                cur.execute(
                    "UPDATE matches SET ScoreA = ?, ScoreB = ?, ToornamentId = ?, "
                    "StageType = ?, StageNumber = ? WHERE MatchID = ?",
                    (m.score_a, m.score_b, m.toornament_id, m.stage_type, m.stage_number, row[0]),
                )
            else:
                cur.execute(
                    "UPDATE matches SET ToornamentId = ?, StageType = ?, StageNumber = ? "
                    "WHERE MatchID = ?",
                    (m.toornament_id, m.stage_type, m.stage_number, row[0]),
                )
        else:
            cur.execute(
                "INSERT INTO matches (TeamA, TeamB, LogoA, LogoB, ScoreA, ScoreB, "
                "ToornamentId, StageType, StageNumber, StageName, GroupName, RoundName) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (m.team_a, m.team_b, m.logo_a, m.logo_b, m.score_a, m.score_b,
                 m.toornament_id, m.stage_type, m.stage_number, m.stage, m.group, m.round),
            )


def node_source(opp):
    """(sourceType, sourceNodeId) for an opponent fed by another node, else (None, None)."""
    st = opp.get("sourceType")
    if st in ("winner", "loser") and opp.get("sourceNode"):
        return st, opp["sourceNode"]["id"]
    return None, None


def node_team(opp, logos):
    """(name, logo) for a known opponent, else (None, None) for a TBD slot."""
    p = opp.get("participant")
    if not p:
        return None, None
    return p["name"].strip(), logos.get(p["id"], "")


def upsert_bracket_nodes(con, stage, logos):
    """Pull every bracket node for `stage` and store it (incl. TBD slots and the
    winner/loser source edges). MatchID is linked when both teams are known."""
    cur = con.cursor()
    nodes = fetch_items(NODES_URL.format(stage["id"]))
    for n in nodes:
        o_a, o_b = n["opponents"]
        team_a, logo_a = node_team(o_a, logos)
        team_b, logo_b = node_team(o_b, logos)
        src_type_a, src_a = node_source(o_a)
        src_type_b, src_b = node_source(o_b)
        # Predictable only when both teams are present — then a matches row exists
        # with ToornamentId == this node id (set by upsert_matches above).
        match_row = cur.execute(
            "SELECT MatchID FROM matches WHERE ToornamentId = ?", (n["id"],)
        ).fetchone()
        cur.execute(
            "INSERT OR REPLACE INTO bracket_nodes (NodeId, StageId, StageName, StageNumber, "
            "StageType, GroupName, Branch, RoundNumber, Position, Depth, TeamA, TeamB, LogoA, "
            "LogoB, ScoreA, ScoreB, SourceTypeA, SourceA, SourceTypeB, SourceB, MatchID) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (n["id"], stage["id"], stage["name"].strip(), stage["number"], stage["type"],
             n["group"]["name"].strip(), n.get("branch"), n["round"]["number"], n["number"],
             n["depth"], team_a, team_b, logo_a, logo_b, o_a["score"], o_b["score"],
             src_type_a, src_a, src_type_b, src_b, match_row[0] if match_row else None),
        )


def main():
    db_path = sys.argv[1] if len(sys.argv) > 1 else "db.sqlite3"

    raw = fetch_items(MATCHES_URL + PAST_MATCHES) + fetch_items(MATCHES_URL + UPCOMING_MATCHES)

    # participant id -> logo, built from the raw feed (covers every named team,
    # including those that only appear in an otherwise-TBD bracket slot).
    logos = {}
    for raw_match in raw:
        for opp in raw_match["opponents"]:
            if opp.get("participant"):
                logos[opp["participant"]["id"]] = participant_logo(opp["participant"])

    matches = [m for m in (build_match(r) for r in raw) if m]
    matches.sort(key=lambda m: m.number)

    # Distinct bracket stages (deduped, keyed by id) seen in the feed.
    bracket_stages = {
        r["stage"]["id"]: r["stage"] for r in raw if r["stage"]["type"] in BRACKET_TYPES
    }

    con = sqlite3.connect(db_path)
    upsert_matches(con, matches)
    con.commit()  # commit matches first so the MatchID links below resolve
    for stage in bracket_stages.values():
        upsert_bracket_nodes(con, stage, logos)
    con.commit()
    con.close()


if __name__ == "__main__":
    main()
