-- Immutable provenance for a member-paid group @AI turn. All values originate from a Chat-signed ticket.
CREATE TABLE group_ai_reservation_context (
  reservation_key TEXT PRIMARY KEY REFERENCES credit_reservations(idempotency_key) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX group_ai_reservation_context_user ON group_ai_reservation_context(user_id,created_at);
