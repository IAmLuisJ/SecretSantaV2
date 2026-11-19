ALTER TABLE seasons ADD COLUMN codename_mode INTEGER NOT NULL DEFAULT 0 CHECK (codename_mode IN (0, 1));
ALTER TABLE assignments ADD COLUMN codename TEXT;

CREATE UNIQUE INDEX assignments_codenames ON assignments(draw_id, codename) WHERE codename IS NOT NULL;
