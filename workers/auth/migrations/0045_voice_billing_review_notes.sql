CREATE TABLE voice_billing_review_notes (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 event_id TEXT NOT NULL UNIQUE,
 reservation_key TEXT NOT NULL REFERENCES voice_billing_reviews(reservation_key) ON DELETE CASCADE,
 operator_id TEXT NOT NULL,
 note TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 observed_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX voice_billing_review_notes_task ON voice_billing_review_notes(reservation_key,sequence DESC);
