-- Additive order and reconciliation data. Existing Credit balances and references are unchanged.
CREATE TABLE billing_orders (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 package_id TEXT NOT NULL,
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 currency TEXT NOT NULL CHECK(currency='CNY'),
 credits INTEGER NOT NULL CHECK(credits>0),
 price_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('awaiting_payment','paid','cancelled','expired','refund_requested','refunded')),
 version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX idx_billing_orders_owner ON billing_orders(user_id,sequence DESC);
CREATE TABLE billing_events (
 provider TEXT NOT NULL,
 event_id TEXT NOT NULL,
 order_id TEXT NOT NULL REFERENCES billing_orders(id) ON DELETE CASCADE,
 payment_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('paid','refunded')),
 amount_minor INTEGER NOT NULL,
 currency TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('received','applied','needs_review')),
 reason TEXT,
 operator_user_id TEXT,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(provider,event_id)
);
CREATE INDEX idx_billing_events_review ON billing_events(state,created_at);
CREATE TABLE billing_payments (
 provider TEXT NOT NULL,
 payment_id TEXT NOT NULL,
 order_id TEXT NOT NULL UNIQUE REFERENCES billing_orders(id) ON DELETE CASCADE,
 ledger_reference TEXT NOT NULL UNIQUE,
 refund_reference TEXT UNIQUE,
 paid_at INTEGER NOT NULL,
 refunded_at INTEGER,
 PRIMARY KEY(provider,payment_id)
);
CREATE TABLE billing_refund_requests (
 order_id TEXT PRIMARY KEY REFERENCES billing_orders(id) ON DELETE CASCADE,
 reason TEXT NOT NULL,
 requested_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
