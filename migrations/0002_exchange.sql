CREATE TABLE groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('organizer', 'member')),
  UNIQUE (group_id, id)
);

CREATE UNIQUE INDEX memberships_one_organizer ON memberships(group_id) WHERE role = 'organizer';

CREATE TABLE seasons (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  year INTEGER NOT NULL CHECK (year BETWEEN 1000 AND 9999),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  active_draw_id TEXT,
  CHECK (completed = 0 OR active_draw_id IS NOT NULL),
  UNIQUE (group_id, year),
  UNIQUE (group_id, id),
  FOREIGN KEY (id, active_draw_id) REFERENCES draws(season_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX seasons_one_open ON seasons(group_id) WHERE completed = 0;

CREATE TABLE season_participants (
  group_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 1 CHECK (eligible IN (0, 1)),
  PRIMARY KEY (season_id, membership_id),
  FOREIGN KEY (group_id, season_id) REFERENCES seasons(group_id, id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, membership_id) REFERENCES memberships(group_id, id) ON DELETE CASCADE
);

CREATE INDEX season_participants_by_member ON season_participants(group_id, membership_id);

CREATE TABLE pair_exclusions (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  first_id TEXT NOT NULL,
  second_id TEXT NOT NULL,
  CHECK (first_id < second_id),
  PRIMARY KEY (group_id, first_id, second_id),
  FOREIGN KEY (group_id, first_id) REFERENCES memberships(group_id, id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, second_id) REFERENCES memberships(group_id, id) ON DELETE CASCADE
);

CREATE INDEX pair_exclusions_by_second_member ON pair_exclusions(group_id, second_id);

CREATE TRIGGER pair_exclusions_revision_insert AFTER INSERT ON pair_exclusions
BEGIN
  UPDATE seasons SET revision = revision + 1 WHERE group_id = NEW.group_id AND completed = 0;
END;

CREATE TRIGGER pair_exclusions_revision_delete AFTER DELETE ON pair_exclusions
BEGIN
  UPDATE seasons SET revision = revision + 1 WHERE group_id = OLD.group_id AND completed = 0;
END;

CREATE TABLE draws (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  request_key TEXT NOT NULL,
  UNIQUE (season_id, id),
  UNIQUE (season_id, request_key),
  FOREIGN KEY (group_id, season_id) REFERENCES seasons(group_id, id) ON DELETE CASCADE
);

CREATE TABLE assignments (
  draw_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  giver_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  CHECK (giver_id <> recipient_id),
  PRIMARY KEY (draw_id, giver_id),
  UNIQUE (draw_id, recipient_id),
  FOREIGN KEY (season_id, draw_id) REFERENCES draws(season_id, id) ON DELETE CASCADE,
  FOREIGN KEY (season_id, giver_id) REFERENCES season_participants(season_id, membership_id) ON DELETE CASCADE,
  FOREIGN KEY (season_id, recipient_id) REFERENCES season_participants(season_id, membership_id) ON DELETE CASCADE
);

CREATE INDEX assignments_by_season_giver ON assignments(season_id, giver_id);
CREATE INDEX assignments_by_season_recipient ON assignments(season_id, recipient_id);

CREATE TABLE invite_requests (
  id TEXT PRIMARY KEY NOT NULL,
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  queued_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX invite_requests_by_member ON invite_requests(membership_id, queued_at);
