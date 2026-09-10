CREATE TABLE market_download_rewards (
  item_id TEXT NOT NULL,
  downloader_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, downloader_user_id),
  CHECK (downloader_user_id <> author_user_id)
);
CREATE INDEX idx_market_download_rewards_author ON market_download_rewards (author_user_id, created_at DESC);
ALTER TABLE credit_ledger RENAME TO credit_ledger_rewards_legacy;
CREATE TABLE credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_credits INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('referral_reward','market_download_reward','market_tip','manual_purchase','usage','refund','support_adjustment','billing_correction')),
  reference_id TEXT NOT NULL,
  price_version TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, kind, reference_id)
);
INSERT INTO credit_ledger (id,user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at)
SELECT id,user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at FROM credit_ledger_rewards_legacy;
DROP TABLE credit_ledger_rewards_legacy;
CREATE INDEX idx_credit_ledger_user_created ON credit_ledger (user_id, created_at DESC);
CREATE UNIQUE INDEX idx_credit_ledger_manual_reference ON credit_ledger (reference_id) WHERE kind = 'manual_purchase';
