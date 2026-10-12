-- Operator observations are append-only. A note never changes the wallet or releases an asset.
CREATE TABLE media_billing_review_notes (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 event_id TEXT NOT NULL UNIQUE,
 reservation_key TEXT NOT NULL REFERENCES media_billing_reviews(reservation_key) ON DELETE CASCADE,
 operator_id TEXT NOT NULL,
 note TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 observed_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX idx_media_billing_review_notes_task ON media_billing_review_notes(reservation_key,sequence DESC);
