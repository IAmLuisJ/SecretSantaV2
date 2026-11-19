-- D1 enforces foreign keys during migrations. Save rows that cascade when
-- the old memberships table is dropped, then restore them in the same migration.
CREATE TABLE membership_backup AS SELECT * FROM memberships;
CREATE TABLE participant_backup AS SELECT * FROM season_participants;
CREATE TABLE assignment_backup AS SELECT * FROM assignments;
CREATE TABLE exclusion_backup AS SELECT * FROM pair_exclusions;
CREATE TABLE invitation_backup AS SELECT * FROM invite_requests;
CREATE TABLE address_backup AS SELECT * FROM addresses;
CREATE TABLE adult_wish_backup AS SELECT * FROM gift_items WHERE owner_id IS NOT NULL;

-- Avoid recording a roster change or scheduling photo cleanup during the copy.
DROP TRIGGER pair_exclusions_revision_insert;
DROP TRIGGER pair_exclusions_revision_delete;
DROP TRIGGER queue_deleted_photo;
DROP TABLE memberships;

CREATE TABLE memberships (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('organizer', 'member')),
  UNIQUE (group_id, id),
  UNIQUE (user_id, group_id)
);
CREATE UNIQUE INDEX memberships_one_organizer ON memberships(group_id) WHERE role = 'organizer';

INSERT INTO memberships SELECT * FROM membership_backup;
INSERT INTO season_participants SELECT * FROM participant_backup;
INSERT INTO assignments SELECT * FROM assignment_backup;
INSERT INTO pair_exclusions SELECT * FROM exclusion_backup;
INSERT INTO invite_requests SELECT * FROM invitation_backup;
INSERT INTO addresses SELECT * FROM address_backup;
INSERT INTO gift_items SELECT * FROM adult_wish_backup;

CREATE TRIGGER pair_exclusions_revision_insert AFTER INSERT ON pair_exclusions
BEGIN
  UPDATE seasons SET revision = revision + 1 WHERE group_id = NEW.group_id AND completed = 0;
END;

CREATE TRIGGER pair_exclusions_revision_delete AFTER DELETE ON pair_exclusions
BEGIN
  UPDATE seasons SET revision = revision + 1 WHERE group_id = OLD.group_id AND completed = 0;
END;

CREATE TRIGGER queue_deleted_photo AFTER DELETE ON gift_items
WHEN OLD.photo_key IS NOT NULL
BEGIN
  INSERT INTO photo_cleanup (photo_key, due_at)
  VALUES (OLD.photo_key, unixepoch() * 1000)
  ON CONFLICT (photo_key) DO UPDATE SET due_at = excluded.due_at;
END;

DROP TABLE membership_backup;
DROP TABLE participant_backup;
DROP TABLE assignment_backup;
DROP TABLE exclusion_backup;
DROP TABLE invitation_backup;
DROP TABLE address_backup;
DROP TABLE adult_wish_backup;
