-- Preserve data before rebuilding the tables: D1 enforces cascading foreign
-- keys during migrations, and copying a wish must not queue its photo for deletion.
CREATE TABLE shared_wish_backup AS SELECT * FROM gift_items;
CREATE TABLE shared_child_backup AS SELECT * FROM children;
DROP TRIGGER queue_deleted_photo;
DROP TABLE gift_items;
DROP TABLE children;

CREATE TABLE children (
  id TEXT PRIMARY KEY,
  manager_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  age INTEGER NOT NULL CHECK (age BETWEEN 0 AND 120)
);

-- Historical rows do not record their creator. Leave management unclaimed
-- until an existing group member explicitly chooses to manage sharing.
INSERT INTO children (id, name, age) SELECT id, name, age FROM shared_child_backup;
CREATE INDEX children_manager ON children(manager_id, name, id);

CREATE TABLE child_exchanges (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, child_id)
);
CREATE INDEX child_exchanges_child ON child_exchanges(child_id, group_id);
INSERT INTO child_exchanges (group_id, child_id) SELECT group_id, id FROM shared_child_backup;

CREATE TABLE gift_items (
  id TEXT PRIMARY KEY,
  -- NULL means this is the same shared wish in every eligible exchange.
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  owner_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  child_id TEXT REFERENCES children(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  url TEXT NOT NULL,
  photo_key TEXT UNIQUE,
  purchased INTEGER NOT NULL DEFAULT 0 CHECK (purchased IN (0, 1)),
  created_at INTEGER NOT NULL,
  CHECK ((owner_id IS NULL) <> (child_id IS NULL)),
  FOREIGN KEY (owner_id, group_id) REFERENCES memberships(user_id, group_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (group_id, child_id) REFERENCES child_exchanges(group_id, child_id) ON DELETE CASCADE
);

INSERT INTO gift_items (id, group_id, owner_id, child_id, name, description, url, photo_key, purchased, created_at)
SELECT i.id, i.group_id, m.user_id, i.child_id, i.name, i.description, i.url, i.photo_key, i.purchased, i.created_at
FROM shared_wish_backup i LEFT JOIN memberships m ON m.id = i.owner_id;

CREATE INDEX gift_items_owner ON gift_items(owner_id, group_id, created_at, id);
CREATE INDEX gift_items_child ON gift_items(child_id, group_id, created_at, id);
CREATE INDEX gift_items_group ON gift_items(group_id);

CREATE TRIGGER queue_deleted_photo AFTER DELETE ON gift_items
WHEN OLD.photo_key IS NOT NULL
BEGIN
  INSERT INTO photo_cleanup (photo_key, due_at)
  VALUES (OLD.photo_key, unixepoch() * 1000)
  ON CONFLICT (photo_key) DO UPDATE SET due_at = excluded.due_at;
END;

DROP TABLE shared_wish_backup;
DROP TABLE shared_child_backup;
