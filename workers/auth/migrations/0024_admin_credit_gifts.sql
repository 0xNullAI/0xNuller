ALTER TABLE credit_ledger RENAME TO credit_ledger_gifts_legacy;

CREATE TABLE credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_credits INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'referral_reward', 'market_download_reward', 'market_tip', 'manual_purchase',
    'admin_gift', 'usage', 'refund', 'support_adjustment', 'billing_correction'
  )),
  reference_id TEXT NOT NULL,
  price_version TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, kind, reference_id)
);

INSERT INTO credit_ledger
  (id, user_id, amount_credits, kind, reference_id, price_version, metadata_json, created_at)
SELECT id, user_id, amount_credits, kind, reference_id, price_version, metadata_json, created_at
FROM credit_ledger_gifts_legacy;

DROP TABLE credit_ledger_gifts_legacy;

CREATE INDEX idx_credit_ledger_user_created ON credit_ledger (user_id, created_at DESC);
CREATE UNIQUE INDEX idx_credit_ledger_manual_reference
  ON credit_ledger (reference_id) WHERE kind = 'manual_purchase';

ALTER TABLE admin_credit_audit RENAME TO admin_credit_audit_gifts_legacy;

CREATE TABLE admin_credit_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_user_id TEXT NOT NULL REFERENCES users(id),
  target_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('manual_purchase', 'admin_gift')),
  amount_cny INTEGER,
  amount_credits INTEGER NOT NULL,
  external_reference TEXT NOT NULL UNIQUE,
  reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK (
    (action = 'manual_purchase' AND amount_cny IS NOT NULL AND reason IS NULL) OR
    (action = 'admin_gift' AND amount_cny IS NULL AND reason IS NOT NULL)
  )
);

INSERT INTO admin_credit_audit
  (id, operator_user_id, target_user_id, action, amount_cny, amount_credits,
   external_reference, reason, created_at)
SELECT id, operator_user_id, target_user_id, action, amount_cny, amount_credits,
       external_reference, NULL, created_at
FROM admin_credit_audit_gifts_legacy;

DROP TABLE admin_credit_audit_gifts_legacy;

CREATE INDEX idx_admin_credit_audit_operator_created
  ON admin_credit_audit (operator_user_id, created_at DESC);
