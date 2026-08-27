CREATE TABLE users
(
    Name     TEXT PRIMARY KEY,
    Password TEXT
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

CREATE TABLE matches
(
    MatchID      INTEGER PRIMARY KEY,
    TournamentID INTEGER NOT NULL REFERENCES tournaments (TournamentID),
    TeamA        TEXT    NOT NULL,
    TeamB        TEXT    NOT NULL,
    LogoA        TEXT    NOT NULL,
    LogoB        TEXT    NOT NULL,
    ScoreA       int,
    ScoreB       int,
    ToornamentId TEXT,
    StageType    TEXT,
    StageNumber  int,
    StageName    TEXT,
    GroupName    TEXT,
    RoundName    TEXT
);

CREATE TABLE tournaments
(
    TournamentID INTEGER PRIMARY KEY,
    Name         TEXT NOT NULL,
    ToornamentId TEXT
);

-- One row per bracket match (node) for tournament-format stages, including
-- not-yet-decided (TBD) slots. SourceA/SourceB are the edges: an opponent comes
-- from the winner/loser of another node. MatchID links to `matches` only when
-- both teams are known (and thus the match is predictable).
CREATE TABLE bracket_nodes
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
