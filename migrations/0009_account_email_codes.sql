CREATE TABLE account_email_codes (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('change-email', 'merge-accounts')),
  current_email TEXT NOT NULL,
  target_email TEXT NOT NULL,
  other_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts_left INTEGER NOT NULL CHECK (attempts_left BETWEEN -1 AND 3),
  expires_at INTEGER NOT NULL,
  UNIQUE (session_id, purpose)
);

CREATE INDEX account_email_codes_other_user ON account_email_codes(other_user_id);
