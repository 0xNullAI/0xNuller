-- A memory the user deleted, replaced or edited must not live on inside a
-- conversation digest, which is sent to the model next to the memory layers.
-- Relationship memories invalidate that relationship's digests; account
-- memories can reach any private conversation, so they invalidate all of the
-- user's digests. The cron rebuilds them from the transcript, skipping the
-- source messages of deleted or replaced memories.
CREATE TRIGGER conversation_digest_memory_changed
AFTER UPDATE OF deleted_at, superseded_by_id, content ON personal_memories
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  OR (OLD.superseded_by_id IS NULL AND NEW.superseded_by_id IS NOT NULL)
  OR (OLD.content IS NOT NEW.content AND OLD.state = 'active')
BEGIN
  DELETE FROM conversation_digests WHERE user_id = NEW.user_id
    AND (NEW.relationship_id IS NULL OR relationship_id = NEW.relationship_id);
END;
