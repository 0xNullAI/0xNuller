-- A durable generated asset must not be charged against an expired hold or
-- discarded when the reservation/ledger outcome cannot be reconciled.
CREATE TABLE media_billing_reviews (
 reservation_key TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 job_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('reservation_expired','reservation_missing','released_with_asset','settled_without_delivery','ledger_mismatch')),
 reserved_credits INTEGER,
 hold_updated_at INTEGER,
 created_at INTEGER NOT NULL,
 FOREIGN KEY(user_id,job_id) REFERENCES media_jobs(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_media_billing_reviews_owner ON media_billing_reviews(user_id,created_at);
