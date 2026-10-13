-- The recent inbox orders live conversations by COALESCE(last_message_at,0) DESC, id. The plain
-- (user_id,last_message_at,id) index cannot serve that expression, so every page sorted all of a
-- user's conversations and ran the preview/unread subqueries for each one. This partial expression
-- index matches the query exactly, so a page reads only its own rows. Additive only.
CREATE INDEX idx_conversation_inbox_recent ON server_conversations(
  user_id, COALESCE(last_message_at,0) DESC, id
) WHERE deleted_at IS NULL;
