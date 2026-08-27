CREATE TABLE tournaments
(
    TournamentID INTEGER PRIMARY KEY,
    Name         TEXT NOT NULL,
    ToornamentId TEXT
);

INSERT INTO tournaments (TournamentID, Name, ToornamentId)
VALUES (1, "Uniliga Overwatch Sommerseason 2026", 2425613637680488447);

ALTER TABLE matches
    ADD COLUMN TournamentID INTEGER NOT NULL REFERENCES tournaments (TournamentID) DEFAULT 1;