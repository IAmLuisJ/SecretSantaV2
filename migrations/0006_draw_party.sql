ALTER TABLE draws ADD COLUMN release_at INTEGER CHECK (release_at > 0);

CREATE VIEW released_draws AS
SELECT id FROM draws WHERE release_at IS NULL OR release_at <= unixepoch();
