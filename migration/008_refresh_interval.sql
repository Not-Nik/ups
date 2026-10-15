-- Shortest gap between two toornament refreshes of a tournament, in seconds, set in the
-- admin panel. Six hours, the interval every tournament had before.
ALTER TABLE tournaments
    ADD COLUMN RefreshInterval INTEGER NOT NULL DEFAULT 21600;
