-- 6.5 turns the former campaign-cent display into an integer Credit ledger.
-- Rebuild the two small tables so new code cannot accidentally keep writing
-- monetary cents under a Credit label.
ALTER TABLE referrals RENAME TO referrals_legacy;

CREATE TABLE referrals (
  invitee_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'rewarded', 'rejected')),
  reward_credits  INTEGER NOT NULL CHECK (reward_credits > 0),
  created_at      INTEGER NOT NULL,
  qualified_at    INTEGER,
  CHECK (invitee_user_id <> inviter_user_id)
);

INSERT INTO referrals
  (invitee_user_id, inviter_user_id, code, status, reward_credits, created_at, qualified_at)
SELECT invitee_user_id, inviter_user_id, code, status, reward_cents, created_at, qualified_at
FROM referrals_legacy;

DROP TABLE referrals_legacy;

CREATE INDEX idx_referrals_inviter_status
  ON referrals (inviter_user_id, status, created_at DESC);

ALTER TABLE credit_ledger RENAME TO credit_ledger_legacy;

CREATE TABLE credit_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_credits  INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
    'referral_reward', 'manual_purchase', 'usage', 'refund',
    'support_adjustment', 'billing_correction'
  )),
  reference_id    TEXT NOT NULL,
  price_version   TEXT,
  metadata_json   TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (user_id, kind, reference_id)
);

INSERT INTO credit_ledger
  (id, user_id, amount_credits, kind, reference_id, price_version, metadata_json, created_at)
SELECT id, user_id, amount_cents,
       CASE WHEN kind = 'campaign_adjustment' THEN 'support_adjustment' ELSE kind END,
       reference_id, 'legacy-credit-v1', NULL, created_at
FROM credit_ledger_legacy;

DROP TABLE credit_ledger_legacy;

CREATE INDEX idx_credit_ledger_user_created
  ON credit_ledger (user_id, created_at DESC);

-- A payment reference can fund only one account, even if an operator types a
-- different username on a later request.
CREATE UNIQUE INDEX idx_credit_ledger_manual_reference
  ON credit_ledger (reference_id) WHERE kind = 'manual_purchase';

-- Reservations prevent concurrent requests from spending the same balance.
-- The caller owns an idempotency key for the complete request lifecycle.
CREATE TABLE credit_reservations (
  idempotency_key TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_kind      TEXT NOT NULL CHECK (usage_kind IN ('agent', 'video', 'voice')),
  model_id        TEXT NOT NULL,
  reserved_credits INTEGER NOT NULL CHECK (reserved_credits > 0),
  charged_credits INTEGER CHECK (charged_credits >= 0),
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'settled', 'released')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_credit_reservations_user_status
  ON credit_reservations (user_id, status, created_at DESC);

CREATE TABLE admin_credit_audit (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_user_id   TEXT NOT NULL REFERENCES users(id),
  target_user_id     TEXT NOT NULL REFERENCES users(id),
  action             TEXT NOT NULL CHECK (action IN ('manual_purchase')),
  amount_cny         INTEGER NOT NULL,
  amount_credits     INTEGER NOT NULL,
  external_reference TEXT NOT NULL UNIQUE,
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_admin_credit_audit_operator_created
  ON admin_credit_audit (operator_user_id, created_at DESC);
