-- The moment an account last made a prediction, which the seven-day window that lets a
-- passwordless account's name be claimed again runs from. Existing rows get "now", so
-- nobody's account is instantly claimable after this migration; the window only starts
-- with real use. The table is rebuilt rather than altered: ALTER TABLE ADD COLUMN only
-- takes a constant default, and a column without one would leave new accounts with no
-- window running at all.
CREATE TABLE users_new
(
    Name         TEXT PRIMARY KEY,
    Password     TEXT,
    Admin        INTEGER NOT NULL DEFAULT 0,
    LastActivity TEXT NOT NULL DEFAULT (datetime('now')) -- UTC of the last prediction
);

INSERT INTO users_new (Name, Password, Admin, LastActivity)
SELECT Name, Password, Admin, datetime('now')
FROM users;

DROP TABLE users;

ALTER TABLE users_new
    RENAME TO users;
