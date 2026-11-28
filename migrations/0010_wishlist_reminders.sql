ALTER TABLE "user" ADD COLUMN wishlist_reminders_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (wishlist_reminders_enabled IN (0, 1));

-- Give existing draws the same grace period as a newly published draw.
ALTER TABLE draws ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
UPDATE draws SET created_at = unixepoch();
CREATE TRIGGER draws_created_at AFTER INSERT ON draws WHEN NEW.created_at = 0
BEGIN
  UPDATE draws SET created_at = unixepoch() WHERE id = NEW.id;
END;

-- SQLite requires rebuilding a table to extend its kind CHECK constraint.
-- Preserve delivery leases and payloads, including ambiguous provider retries.
CREATE TABLE email_outbox_next (
  event_key TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('welcome', 'invite', 'draw', 'wishlist-reminder')),
  group_id TEXT NOT NULL,
  draw_id TEXT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  first_attempt_at INTEGER,
  sender TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  lease_token TEXT,
  sent_at INTEGER,
  provider_id TEXT,
  last_error TEXT,
  reminder_member_id TEXT,
  unsubscribe_url TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((kind IN ('draw', 'wishlist-reminder')) = (draw_id IS NOT NULL)),
  CHECK ((kind = 'wishlist-reminder') = (reminder_member_id IS NOT NULL)),
  CHECK ((kind = 'wishlist-reminder') = (unsubscribe_url IS NOT NULL))
);

INSERT INTO email_outbox_next (
  event_key, kind, group_id, draw_id, recipient, subject, body, status,
  next_attempt_at, first_attempt_at, sender, attempts, lease_until, lease_token,
  sent_at, provider_id, last_error
)
SELECT event_key, kind, group_id, draw_id, recipient, subject, body, status,
  next_attempt_at, first_attempt_at, sender, attempts, lease_until, lease_token,
  sent_at, provider_id, last_error
FROM email_outbox;

DROP TABLE email_outbox;
ALTER TABLE email_outbox_next RENAME TO email_outbox;
CREATE INDEX email_outbox_due_idx ON email_outbox(next_attempt_at, event_key) WHERE status = 'pending';
CREATE INDEX email_outbox_group_status_idx ON email_outbox(group_id, status, draw_id);
CREATE INDEX email_outbox_reminder_member_idx ON email_outbox(reminder_member_id, created_at)
  WHERE kind = 'wishlist-reminder';
