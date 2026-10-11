-- Realtime calls settle from provider-reported usage, round by round. A call with a round
-- that ended without a usage report, or whose reported usage exceeds the hold, is charged
-- only what was reported (capped at the hold) and kept here for an operator. Nothing is
-- estimated. Additive only: older Workers never read or write this table.
CREATE TABLE voice_usage_reviews (
 reservation_key TEXT PRIMARY KEY REFERENCES credit_reservations(idempotency_key) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reason TEXT NOT NULL CHECK(reason IN ('usage_missing','over_reservation')),
 rounds INTEGER NOT NULL CHECK(rounds>=0),
 missing_rounds INTEGER NOT NULL CHECK(missing_rounds>=0),
 observed_duration_ms INTEGER NOT NULL CHECK(observed_duration_ms>=0),
 usage_json TEXT NOT NULL,
 computed_credits INTEGER NOT NULL CHECK(computed_credits>=0),
 charged_credits INTEGER NOT NULL CHECK(charged_credits>=0),
 reserved_credits INTEGER NOT NULL,
 price_version TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX voice_usage_reviews_owner ON voice_usage_reviews(user_id,created_at);
