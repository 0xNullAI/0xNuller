-- A model context digest is derived from one private conversation. It is not a
-- confirmed personal memory and never replaces the source transcript.
CREATE TABLE conversation_digests (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  through_position INTEGER NOT NULL CHECK (through_position >= 0),
  through_message_id TEXT NOT NULL,
  -- Empty means the model found no useful continuity content in this segment.
  -- The cursor still advances, and the client omits the empty text.
  summary TEXT NOT NULL CHECK (length(summary) <= 4000),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id),
  FOREIGN KEY (user_id, conversation_id) REFERENCES server_conversations(user_id, id) ON DELETE CASCADE
);
CREATE TABLE conversation_digest_preferences (
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id,relationship_id),
  FOREIGN KEY (user_id,relationship_id) REFERENCES character_relationships(user_id,id) ON DELETE CASCADE
);
CREATE TABLE conversation_digest_attempts (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, conversation_id),
  FOREIGN KEY (user_id, conversation_id) REFERENCES server_conversations(user_id, id) ON DELETE CASCADE
);

-- Older source edits and removals invalidate the digest before it can be read.
CREATE TRIGGER conversation_digest_source_changed AFTER UPDATE OF content,role,position,kind
ON server_conversation_messages BEGIN
  DELETE FROM conversation_digests WHERE user_id=OLD.user_id
    AND conversation_id=OLD.conversation_id AND OLD.position<=through_position;
END;
CREATE TRIGGER conversation_digest_source_deleted AFTER DELETE
ON server_conversation_messages BEGIN
  DELETE FROM conversation_digests WHERE user_id=OLD.user_id
    AND conversation_id=OLD.conversation_id AND OLD.position<=through_position;
END;
CREATE TRIGGER conversation_digest_source_inserted AFTER INSERT
ON server_conversation_messages BEGIN
  DELETE FROM conversation_digests WHERE user_id=NEW.user_id
    AND conversation_id=NEW.conversation_id AND NEW.position<=through_position;
END;
CREATE TRIGGER conversation_digest_identity_changed AFTER UPDATE OF metadata,deleted_at
ON server_conversations
WHEN OLD.deleted_at IS NOT NEW.deleted_at
  OR json_extract(OLD.metadata,'$.relationshipId') IS NOT json_extract(NEW.metadata,'$.relationshipId')
  OR json_extract(OLD.metadata,'$.promptPresetId') IS NOT json_extract(NEW.metadata,'$.promptPresetId')
BEGIN
  DELETE FROM conversation_digests WHERE user_id=OLD.user_id AND conversation_id=OLD.id;
END;
