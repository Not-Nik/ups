-- One row per lineup entry of a team. Toornament gives lineup entries no id, so the
-- loader replaces a team's whole lineup on every refresh. Names aren't unique, not even
-- within a tournament (the same person can be listed on several teams, e.g. as coach).
CREATE TABLE players
(
    PlayerID         INTEGER PRIMARY KEY,
    TeamID           INTEGER NOT NULL REFERENCES teams (TeamID) ON DELETE CASCADE,
    Position         INTEGER NOT NULL, -- order in the toornament lineup
    Name             TEXT    NOT NULL,
    BattleTag        TEXT,             -- customFieldValues.battle_net_id
    ToornamentUserId TEXT,             -- playerUser.id, NULL when not linked to an account
    UNIQUE (TeamID, Position)
);
