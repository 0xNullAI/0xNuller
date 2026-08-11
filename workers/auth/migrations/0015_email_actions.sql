ALTER TABLE users ADD COLUMN email_verified_at INTEGER;

CREATE TABLE email_action_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX idx_email_actions_user ON email_action_tokens(user_id, purpose, created_at);
CREATE INDEX idx_email_actions_expiry ON email_action_tokens(expires_at);
