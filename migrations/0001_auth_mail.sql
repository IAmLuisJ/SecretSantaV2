CREATE TABLE "user" (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL,
  image TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON session(userId);
CREATE INDEX session_expiry_idx ON session(expiresAt);

CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX account_user_idx ON account(userId);

CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX verification_expiry_idx ON verification(expiresAt);

CREATE TABLE auth_rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  next_allowed_at INTEGER NOT NULL
);
CREATE INDEX auth_rate_limits_expiry_idx ON auth_rate_limits(expires_at);

-- Outbox rows survive group deletion so cancelled delivery can never be reclaimed.
CREATE TABLE email_outbox (
  event_key TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('welcome','invite','draw')),
  group_id TEXT NOT NULL,
  draw_id TEXT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','cancelled')),
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  first_attempt_at INTEGER,
  sender TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  lease_token TEXT,
  sent_at INTEGER,
  provider_id TEXT,
  last_error TEXT,
  CHECK ((kind = 'draw') = (draw_id IS NOT NULL))
);
CREATE INDEX email_outbox_due_idx ON email_outbox(next_attempt_at, event_key) WHERE status = 'pending';
CREATE INDEX email_outbox_group_status_idx ON email_outbox(group_id, status, draw_id);
