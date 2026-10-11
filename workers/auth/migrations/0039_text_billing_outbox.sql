-- Additive: no changes to the shared wallet, prices or existing reservations.
CREATE TABLE text_billing_outbox (
 reservation_key TEXT PRIMARY KEY REFERENCES credit_reservations(idempotency_key) ON DELETE CASCADE,
 capability TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','ready','settled','released','needs_review')),
 action TEXT CHECK(action IN ('settle','release')),
 charge INTEGER,
 metadata_json TEXT,
 reason TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL
);
CREATE INDEX text_billing_outbox_due ON text_billing_outbox(state,updated_at);
