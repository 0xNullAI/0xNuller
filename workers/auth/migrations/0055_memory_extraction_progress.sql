-- Keep an opt-in conversation's extraction cursor separate from its transient job.
-- No provider call or backfill is started by this migration.
CREATE TABLE memory_extraction_progress (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  last_position INTEGER NOT NULL,
  last_id TEXT NOT NULL,
  PRIMARY KEY(user_id,conversation_id),
  FOREIGN KEY(user_id,conversation_id)
    REFERENCES server_conversations(user_id,id) ON DELETE CASCADE
);

-- A correction invalidates dependent memories in migration 0047. Revisit
-- the corrected source and all later messages on the next queued run.
CREATE TRIGGER rewind_memory_extraction_on_user_change
AFTER UPDATE OF content ON server_conversation_messages
WHEN NEW.role='user' AND NEW.content<>OLD.content
BEGIN
  UPDATE memory_extraction_progress SET last_position=NEW.position-1,last_id=''
  WHERE user_id=NEW.user_id AND conversation_id=NEW.conversation_id
    AND last_position>=NEW.position;
END;

CREATE TRIGGER reset_memory_extraction_on_relationship_change
AFTER UPDATE OF metadata ON server_conversations
WHEN json_extract(NEW.metadata,'$.relationshipId')
  IS NOT json_extract(OLD.metadata,'$.relationshipId')
BEGIN
  DELETE FROM memory_extraction_progress
  WHERE user_id=NEW.user_id AND conversation_id=NEW.id;
END;
