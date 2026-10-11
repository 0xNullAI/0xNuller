CREATE TABLE text_billing_reviews (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 event_id TEXT NOT NULL UNIQUE,
 reservation_key TEXT NOT NULL REFERENCES text_billing_outbox(reservation_key) ON DELETE CASCADE,
 operator_id TEXT NOT NULL,
 note TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 observed_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX text_billing_reviews_task ON text_billing_reviews(reservation_key,sequence DESC);
