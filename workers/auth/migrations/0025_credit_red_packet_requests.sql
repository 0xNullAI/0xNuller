ALTER TABLE credit_ledger RENAME TO credit_ledger_red_packet_legacy;
CREATE TABLE credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_credits INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'referral_reward', 'market_download_reward', 'market_tip', 'manual_purchase',
    'admin_gift', 'red_packet', 'usage', 'refund', 'support_adjustment', 'billing_correction'
  )),
  reference_id TEXT NOT NULL,
  price_version TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, kind, reference_id)
);
INSERT INTO credit_ledger SELECT * FROM credit_ledger_red_packet_legacy;
DROP TABLE credit_ledger_red_packet_legacy;
CREATE INDEX idx_credit_ledger_user_created ON credit_ledger (user_id, created_at DESC);
CREATE UNIQUE INDEX idx_credit_ledger_manual_reference
  ON credit_ledger (reference_id) WHERE kind = 'manual_purchase';

CREATE TABLE credit_red_packet_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')) DEFAULT 'pending',
  reject_reason TEXT,
  processed_by TEXT REFERENCES users(id),
  processed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, code)
);

CREATE INDEX idx_credit_red_packet_status_created
  ON credit_red_packet_requests (status, created_at DESC);

CREATE INDEX idx_credit_red_packet_user_created
  ON credit_red_packet_requests (user_id, created_at DESC);
