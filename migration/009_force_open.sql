-- Keeps a stage's groups taking standing predictions after one of their matches has been
-- scored, set in the admin panel. Off by default, so a stage locks itself with its first
-- result like before.
ALTER TABLE stages
    ADD COLUMN ForceOpen INTEGER NOT NULL DEFAULT 0;
