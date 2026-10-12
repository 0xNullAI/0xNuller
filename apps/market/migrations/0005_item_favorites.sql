CREATE TABLE IF NOT EXISTS item_favorites (
  account_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_item_favorites_account ON item_favorites(account_id, created_at DESC);
