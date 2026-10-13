-- Redeem keys replace manual top-ups. An admin mints a batch of single-use keys for one tier;
-- a user redeems one and the Credit lands in credit_ledger as `manual_purchase` with
-- reference `redeem:<code id>`, so the ledger table is not rebuilt for a new kind.
-- Only a SHA-256 of each key is kept; the plaintext is shown to the admin once.

CREATE TABLE redeem_batches (
  id TEXT PRIMARY KEY,
  amount_cny INTEGER NOT NULL CHECK (amount_cny > 0),
  amount_credits INTEGER NOT NULL CHECK (amount_credits > 0),
  code_count INTEGER NOT NULL CHECK (code_count > 0),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_redeem_batches_created ON redeem_batches (created_at);
CREATE INDEX idx_redeem_batches_operator ON redeem_batches (created_by, created_at);

CREATE TABLE redeem_codes (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES redeem_batches(id),
  code_hash TEXT NOT NULL UNIQUE,
  -- The last four characters, so an admin can tell keys apart without the plaintext.
  code_tail TEXT NOT NULL,
  amount_credits INTEGER NOT NULL CHECK (amount_credits > 0),
  redeemed_by TEXT REFERENCES users(id),
  redeemed_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK ((redeemed_by IS NULL) = (redeemed_at IS NULL))
);
CREATE INDEX idx_redeem_codes_batch ON redeem_codes (batch_id);
CREATE INDEX idx_redeem_codes_redeemed ON redeem_codes (redeemed_at) WHERE redeemed_at IS NOT NULL;

-- Failed redemptions, for the per-account and per-IP lockout. Pruned by the daily cron.
CREATE TABLE redeem_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_redeem_attempts_user ON redeem_attempts (user_id, created_at);
CREATE INDEX idx_redeem_attempts_ip ON redeem_attempts (ip_hash, created_at);

-- The admin billing view filters and sums the whole ledger by time and kind.
CREATE INDEX idx_credit_ledger_created ON credit_ledger (created_at);
CREATE INDEX idx_credit_ledger_kind_created ON credit_ledger (kind, created_at);
