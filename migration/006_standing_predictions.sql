-- A user's guess at the top four of a group's standings, one row per predicted position.
-- Only stored and returned by the server; scoring happens elsewhere.
CREATE TABLE standing_predictions
(
    Name     TEXT    NOT NULL REFERENCES users (Name) ON DELETE CASCADE,
    GroupID  INTEGER NOT NULL REFERENCES groups (GroupID) ON DELETE CASCADE,
    Position INTEGER NOT NULL CHECK (Position BETWEEN 1 AND 4),
    TeamID   INTEGER NOT NULL REFERENCES teams (TeamID),
    PRIMARY KEY (Name, GroupID, Position), -- one team per slot
    UNIQUE (Name, GroupID, TeamID)         -- a team can't fill two slots
);
