-- Preserve known usage evidence when the original hold is no longer spend-protected.
CREATE TABLE voice_billing_reviews (
 reservation_key TEXT PRIMARY KEY REFERENCES credit_reservations(idempotency_key) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reason TEXT NOT NULL CHECK(reason='reservation_expired'),
 requested_action TEXT NOT NULL CHECK(requested_action IN ('settle','release')),
 observed_duration_ms INTEGER NOT NULL CHECK(observed_duration_ms>=0),
 requested_credits INTEGER NOT NULL CHECK(requested_credits>=0),
 reserved_credits INTEGER NOT NULL,
 price_version TEXT NOT NULL,
 hold_updated_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX voice_billing_reviews_owner ON voice_billing_reviews(user_id,created_at);
