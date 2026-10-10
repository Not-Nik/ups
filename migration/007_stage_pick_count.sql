-- How many places of a stage's groups users predict (the "top N"), set in the admin panel.
-- standing_predictions only allowed positions 1 to 4; SQLite can't change a CHECK in
-- place, so the table is rebuilt. The upper bound is now the stage's PickCount, enforced
-- by the server on submit.
BEGIN;

ALTER TABLE stages
    ADD COLUMN PickCount INTEGER NOT NULL DEFAULT 4;

CREATE TABLE standing_predictions_new
(
    Name     TEXT    NOT NULL REFERENCES users (Name) ON DELETE CASCADE,
    GroupID  INTEGER NOT NULL REFERENCES groups (GroupID) ON DELETE CASCADE,
    Position INTEGER NOT NULL CHECK (Position >= 1),
    TeamID   INTEGER NOT NULL REFERENCES teams (TeamID),
    PRIMARY KEY (Name, GroupID, Position), -- one team per slot
    UNIQUE (Name, GroupID, TeamID)         -- a team can't fill two slots
);

INSERT INTO standing_predictions_new (Name, GroupID, Position, TeamID)
SELECT Name, GroupID, Position, TeamID
FROM standing_predictions;

DROP TABLE standing_predictions;

ALTER TABLE standing_predictions_new
    RENAME TO standing_predictions;

-- The last script applied by hand: the server migrates on its own from here on, and
-- reads where the database is from this number.
PRAGMA user_version = 7;

COMMIT;
