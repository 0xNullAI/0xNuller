-- Source links for reviewable, extractive medium-term excerpts across one private relationship.
-- Only opaque conversation/message IDs are duplicated; source text remains in its owner table.
ALTER TABLE personal_memories ADD COLUMN source_refs TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(source_refs) AND json_type(source_refs) = 'array');

CREATE TABLE memory_summary_sources (
  user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (user_id,memory_id,conversation_id,message_id),
  FOREIGN KEY (user_id,memory_id) REFERENCES personal_memories(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_memory_summary_source ON memory_summary_sources(user_id,conversation_id,message_id,memory_id);

-- One INSERT statement creates both the candidate and all its source links.
CREATE TRIGGER index_memory_summary_sources AFTER INSERT ON personal_memories
WHEN json_array_length(NEW.source_refs) > 0
BEGIN
  INSERT INTO memory_summary_sources(user_id,memory_id,conversation_id,message_id)
  SELECT NEW.user_id,NEW.id,json_extract(value,'$.conversationId'),json_extract(value,'$.messageId')
  FROM json_each(NEW.source_refs);
END;

-- A derived source set is immutable. Manual editing may correct the displayed
-- text, but cannot silently replace its provenance or remove invalidation.
CREATE TRIGGER keep_memory_summary_sources BEFORE UPDATE OF source_refs ON personal_memories
WHEN NEW.source_refs <> OLD.source_refs
BEGIN
  SELECT RAISE(ABORT,'memory source references are immutable');
END;

-- The version tombstone remains; the reverse index no longer needs to follow
-- a memory whose text has been erased or whose relationship was removed.
CREATE TRIGGER prune_memory_summary_sources AFTER UPDATE OF deleted_at ON personal_memories
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  DELETE FROM memory_summary_sources WHERE user_id=NEW.user_id AND memory_id=NEW.id;
END;

-- Source changes erase all derived text and leave the memory version tombstone.
CREATE TRIGGER invalidate_summary_on_message_update AFTER UPDATE OF content,role ON server_conversation_messages
WHEN NEW.content <> OLD.content OR NEW.role <> OLD.role
BEGIN
  UPDATE personal_memories SET title='',content='',deleted_at=CAST(strftime('%s','now') AS INTEGER)*1000,
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,version=version+1
  WHERE user_id=OLD.user_id AND deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM memory_summary_sources s WHERE s.user_id=OLD.user_id AND s.memory_id=personal_memories.id
      AND s.conversation_id=OLD.conversation_id AND s.message_id=OLD.id
  );
END;

CREATE TRIGGER invalidate_summary_on_message_delete AFTER DELETE ON server_conversation_messages
BEGIN
  UPDATE personal_memories SET title='',content='',deleted_at=CAST(strftime('%s','now') AS INTEGER)*1000,
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,version=version+1
  WHERE user_id=OLD.user_id AND deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM memory_summary_sources s WHERE s.user_id=OLD.user_id AND s.memory_id=personal_memories.id
      AND s.conversation_id=OLD.conversation_id AND s.message_id=OLD.id
  );
END;

CREATE TRIGGER invalidate_summary_on_conversation_delete AFTER UPDATE OF deleted_at ON server_conversations
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  UPDATE personal_memories SET title='',content='',deleted_at=NEW.deleted_at,
    updated_at=NEW.deleted_at,version=version+1
  WHERE user_id=NEW.user_id AND deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM memory_summary_sources s WHERE s.user_id=NEW.user_id AND s.memory_id=personal_memories.id
      AND s.conversation_id=NEW.id
  );
END;

CREATE TRIGGER invalidate_summary_on_conversation_rebind AFTER UPDATE OF metadata ON server_conversations
WHEN json_extract(NEW.metadata,'$.relationshipId') IS NOT json_extract(OLD.metadata,'$.relationshipId')
  OR json_extract(NEW.metadata,'$.promptPresetId') IS NOT json_extract(OLD.metadata,'$.promptPresetId')
BEGIN
  UPDATE personal_memories SET title='',content='',deleted_at=CAST(strftime('%s','now') AS INTEGER)*1000,
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,version=version+1
  WHERE user_id=NEW.user_id AND deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM memory_summary_sources s WHERE s.user_id=NEW.user_id AND s.memory_id=personal_memories.id
      AND s.conversation_id=NEW.id
  );
END;
