CREATE TABLE users
(
    Name     TEXT PRIMARY KEY,
    Password TEXT
);

CREATE TABLE sessions
(
    Name  TEXT NOT NULL,
    Token TEXT PRIMARY KEY
);

CREATE TABLE prediction
(
    Name    TEXT NOT NULL,
    MatchID int  NOT NULL,
    ScoreA  int  NOT NULL,
    ScoreB  int  NOT NULL
);

CREATE TABLE matches
(
    MatchID INTEGER PRIMARY KEY,
    TeamA   TEXT NOT NULL,
    TeamB   TEXT NOT NULL
);
