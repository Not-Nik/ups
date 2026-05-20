import requests
import sqlite3

BASE_URL = "https://play.toornament.com"
TOURNAMENT_ID = "2425613637680488447"
MATCHES_URL = f"{BASE_URL}/api/matches?tournament_ids={TOURNAMENT_ID}&"
PAST_MATCHES = "statuses=running,completed&sort=latest_results"
UPCOMING_MATCHES = "statuses=pending&sort=scheduled_asc"


class Match:
    def __init__(self, team_a, team_b, logo_a=None, logo_b=None,
                 score_a=None, score_b=None, stage=None, group=None, round=None):
        self.team_a = team_a
        self.team_b = team_b
        self.logo_a = logo_a
        self.logo_b = logo_b
        self.score_a = score_a
        self.score_b = score_b
        self.stage = stage
        self.group = group
        self.round = round

    def __str__(self):
        return str(self.__dict__)

    def __repr__(self):
        return str(self.__dict__)


def load_matches(url):
    range_start = 0
    range_end = 19

    matches = []

    while True:
        headers = {"Range": f"matches={range_start}-{range_end}"}
        data = requests.get(url, headers=headers).json()
        print(f"Loaded range {range_start}-{range_end}")

        for match in data:
            if not match["opponents"][0]["participant"] or not match["opponents"][1]["participant"]:
                continue
            team_a = match["opponents"][0]["participant"]["name"].strip()
            team_b = match["opponents"][1]["participant"]["name"].strip()
            stage = match["stage"]["name"].strip()
            group = match["group"]["name"].strip()
            round = match["round"]["name"].strip()

            if round.startswith("Round"):
                round = "Day" + round.lstrip("Round")

            if match["opponents"][0]["participant"]["logo"]:
                logo_a = match["opponents"][0]["participant"]["customFieldValues"]["logo"]["icon_medium"].strip()
            else:
                logo_a = ""

            if match["opponents"][1]["participant"]["logo"]:
                logo_b = match["opponents"][1]["participant"]["customFieldValues"]["logo"]["icon_medium"].strip()
            else:
                logo_b = ""

            score_a = match["opponents"][0]["score"]
            score_b = match["opponents"][1]["score"]

            match = Match(team_a, team_b, logo_a, logo_b, score_a, score_b, stage, group, round)
            matches.append(match)
        if len(data) < range_end - range_start:
            break
        range_start += 20
        range_end += 20
    return matches


def main():
    past_matches = load_matches(MATCHES_URL + PAST_MATCHES)
    upcoming_matches = load_matches(MATCHES_URL + UPCOMING_MATCHES)
    matches = past_matches + upcoming_matches

    con = sqlite3.connect("db.sqlite3")

    for match in matches:
        cur = con.cursor()
        section = f"{match.stage}/{match.group}/{match.round}"
        cur.execute("SELECT EXISTS(SELECT 1 FROM matches WHERE TeamA = ? AND TeamB = ? AND Section = ?)",
                    (match.team_a, match.team_b, section))
        exists = cur.fetchone()[0] == 1

        if exists and match.score_a != None and match.score_b != None:
            cur.execute("UPDATE matches SET ScoreA = ?, ScoreB = ? WHERE TeamA = ? AND TeamB = ? AND Section = ?",
                        (match.score_a, match.score_b, match.team_a, match.team_b, section))
        elif not exists and match.score_a != None and match.score_b != None:
            cur.execute("INSERT INTO matches (TeamA, TeamB, LogoA, LogoB, Section, ScoreA, ScoreB)"
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (match.team_a, match.team_b, match.logo_a, match.logo_b, section, match.score_a, match.score_b))
        elif not exists:
            cur.execute("INSERT INTO matches (TeamA, TeamB, LogoA, LogoB, Section) VALUES (?, ?, ?, ?, ?)",
                        (match.team_a, match.team_b, match.logo_a, match.logo_b, section))

        con.commit()


if __name__ == "__main__":
    main()
