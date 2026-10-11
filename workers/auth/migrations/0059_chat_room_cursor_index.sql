-- Covers account-scoped keyset pagination, including deterministic same-millisecond ties.
CREATE INDEX IF NOT EXISTS idx_user_chat_rooms_cursor
ON user_chat_rooms (user_id, updated_at DESC, code ASC);
