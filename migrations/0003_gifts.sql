CREATE TABLE addresses (
  member_id TEXT PRIMARY KEY REFERENCES memberships(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT NOT NULL,
  city TEXT NOT NULL,
  region TEXT NOT NULL,
  postal_code TEXT NOT NULL
);

CREATE TABLE children (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  age INTEGER NOT NULL CHECK (age BETWEEN 0 AND 120),
  UNIQUE (group_id, id)
);

CREATE TABLE gift_items (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  owner_id TEXT,
  child_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  url TEXT NOT NULL,
  photo_key TEXT UNIQUE,
  purchased INTEGER NOT NULL DEFAULT 0 CHECK (purchased IN (0, 1)),
  created_at INTEGER NOT NULL,
  CHECK ((owner_id IS NULL) <> (child_id IS NULL)),
  CHECK (child_id IS NOT NULL OR purchased = 0),
  FOREIGN KEY (group_id, owner_id) REFERENCES memberships(group_id, id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, child_id) REFERENCES children(group_id, id) ON DELETE CASCADE
);

CREATE INDEX gift_items_owner ON gift_items(owner_id, created_at);
CREATE INDEX gift_items_child ON gift_items(child_id, created_at);
CREATE INDEX gift_items_group ON gift_items(group_id);

CREATE TABLE photo_cleanup (
  photo_key TEXT PRIMARY KEY,
  due_at INTEGER NOT NULL
);

CREATE INDEX photo_cleanup_due ON photo_cleanup(due_at);

CREATE TRIGGER queue_deleted_photo AFTER DELETE ON gift_items
WHEN OLD.photo_key IS NOT NULL
BEGIN
  INSERT INTO photo_cleanup (photo_key, due_at)
  VALUES (OLD.photo_key, unixepoch() * 1000)
  ON CONFLICT (photo_key) DO UPDATE SET due_at = excluded.due_at;
END;

CREATE TABLE invite_lookup_limits (
  client_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  hits INTEGER NOT NULL
);

CREATE INDEX invite_lookup_expiry ON invite_lookup_limits(expires_at);
