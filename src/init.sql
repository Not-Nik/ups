-- The number of the last script in migration/ this schema includes. The server reads it
-- on startup and applies the newer ones; raise it whenever a migration is added.
PRAGMA user_version = 10;

CREATE TABLE users
(
    Name         TEXT PRIMARY KEY,
    Password     TEXT,
    Admin        INTEGER NOT NULL DEFAULT 0,
    LastActivity TEXT NOT NULL DEFAULT (datetime('now')) -- UTC of the last prediction; a passwordless account is claimable once this is seven days old
);

CREATE TABLE sessions
(
    Name  TEXT NOT NULL REFERENCES users (Name) ON DELETE CASCADE,
    Token TEXT PRIMARY KEY
);

CREATE TABLE predictions
(
    Name    TEXT NOT NULL REFERENCES users (Name) ON DELETE CASCADE,
    MatchID int  NOT NULL,
    ScoreA  int  NOT NULL,
    ScoreB  int  NOT NULL
);

CREATE TABLE tournaments
(
    TournamentID INTEGER PRIMARY KEY,
    Name         TEXT NOT NULL,
    ToornamentId TEXT,
    RefreshInterval INTEGER NOT NULL DEFAULT 21600 -- seconds between toornament refreshes
);

-- The toornament tree: tournament -> stage -> group -> round. ToornamentId is the
-- toornament id used to match rows across refreshes; NULL for manually created rows.
CREATE TABLE stages
(
    StageID      INTEGER PRIMARY KEY,
    TournamentID INTEGER NOT NULL REFERENCES tournaments (TournamentID),
    Number       INTEGER NOT NULL,
    Name         TEXT    NOT NULL,
    Type         TEXT    NOT NULL, -- league | swiss | pools | double_elimination | ...
    Status       TEXT,             -- pending | running | completed
    ToornamentId TEXT,
    PickCount    INTEGER NOT NULL DEFAULT 4, -- places users predict per group, see standing_predictions
    ForceOpen    INTEGER NOT NULL DEFAULT 0, -- keep taking standing picks after a match has a score
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

-- Name is toornament's own ("Round 1" for swiss, "Day 1" for leagues).
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

-- One row per participant per tournament. ToornamentId is the participant id.
-- Names aren't unique: teams rename mid-season (even swapping names), and toornament
-- doesn't enforce unique names either.
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

-- Current table of a league/swiss group, replaced per group on every refresh.
CREATE TABLE standings
(
    GroupID      INTEGER NOT NULL REFERENCES groups (GroupID) ON DELETE CASCADE,
    TeamID       INTEGER NOT NULL REFERENCES teams (TeamID),
    Position     INTEGER NOT NULL, -- unique display order
    Rank         INTEGER NOT NULL, -- may tie
    Points       INTEGER,
    Played       INTEGER NOT NULL DEFAULT 0,
    Wins         INTEGER NOT NULL DEFAULT 0,
    Draws        INTEGER NOT NULL DEFAULT 0,
    Losses       INTEGER NOT NULL DEFAULT 0,
    Forfeits     INTEGER NOT NULL DEFAULT 0,
    ScoreFor     INTEGER,          -- NULL for swiss
    ScoreAgainst INTEGER,          -- NULL for swiss
    Dropped      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (GroupID, TeamID),
    UNIQUE (GroupID, Position)
);

-- A user's guess at the top of a group's standings, one row per predicted position, up
-- to the stage's PickCount (enforced by the server on submit).
-- Only stored and returned by the server; scoring happens elsewhere.
CREATE TABLE standing_predictions
(
    Name     TEXT    NOT NULL REFERENCES users (Name) ON DELETE CASCADE,
    GroupID  INTEGER NOT NULL REFERENCES groups (GroupID) ON DELETE CASCADE,
    Position INTEGER NOT NULL CHECK (Position >= 1),
    TeamID   INTEGER NOT NULL REFERENCES teams (TeamID),
    PRIMARY KEY (Name, GroupID, Position), -- one team per slot
    UNIQUE (Name, GroupID, TeamID)         -- a team can't fill two slots
);

CREATE TABLE matches
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

-- One row per bracket match (node) for tournament-format stages, including
-- not-yet-decided (TBD) slots. SourceA/SourceB are the edges: an opponent comes
-- from the winner/loser of another node. MatchID links to `matches` only when
-- both teams are known (and thus the match is predictable).
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
