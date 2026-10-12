CREATE TABLE IF NOT EXISTS creator_follows (
  account_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,creator_id)
);
CREATE INDEX IF NOT EXISTS idx_creator_follows_account ON creator_follows(account_id,created_at DESC);
