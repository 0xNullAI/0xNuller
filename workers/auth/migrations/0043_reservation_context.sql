CREATE TABLE reservation_context (
 reservation_key TEXT PRIMARY KEY REFERENCES credit_reservations(idempotency_key) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 relationship_id TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX reservation_context_conversation ON reservation_context(user_id,conversation_id,created_at);
