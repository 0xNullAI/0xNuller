-- Opt-in model extraction stages reviewable private memories from owned user messages.
-- Existing relationships remain off; no old conversation is sent to a provider by migration.
CREATE TABLE relationship_memory_preferences (
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, relationship_id),
  FOREIGN KEY (user_id, relationship_id) REFERENCES character_relationships(user_id, id) ON DELETE CASCADE
);

CREATE TABLE memory_extraction_jobs (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  due_at INTEGER NOT NULL,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (user_id, conversation_id),
  FOREIGN KEY (user_id, conversation_id) REFERENCES server_conversations(user_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_memory_extraction_due ON memory_extraction_jobs(due_at, lease_until, attempts);

CREATE TRIGGER queue_memory_on_user_message AFTER INSERT ON server_conversation_messages
WHEN NEW.role = 'user' AND EXISTS (
  SELECT 1 FROM server_conversations c
  JOIN character_relationships r ON r.user_id = c.user_id
    AND r.id = json_extract(c.metadata, '$.relationshipId')
    AND r.character_id = json_extract(c.metadata, '$.promptPresetId')
    AND r.deleted_at IS NULL
  JOIN relationship_memory_preferences p ON p.user_id = r.user_id
    AND p.relationship_id = r.id AND p.enabled = 1
  WHERE c.user_id = NEW.user_id AND c.id = NEW.conversation_id AND c.deleted_at IS NULL
)
BEGIN
  INSERT INTO memory_extraction_jobs(user_id, conversation_id, generation, due_at)
  VALUES(NEW.user_id, NEW.conversation_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 30000)
  ON CONFLICT(user_id, conversation_id) DO UPDATE SET
    generation = generation + 1, due_at = excluded.due_at,
    lease_until = NULL, attempts = 0, last_error = NULL;
END;

CREATE TRIGGER queue_memory_on_user_change AFTER UPDATE OF content ON server_conversation_messages
WHEN NEW.role = 'user' AND NEW.content <> OLD.content
BEGIN
  INSERT INTO memory_extraction_jobs(user_id, conversation_id, generation, due_at)
  SELECT NEW.user_id, NEW.conversation_id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 30000
  WHERE EXISTS (
    SELECT 1 FROM server_conversations c
    JOIN character_relationships r ON r.user_id = c.user_id
      AND r.id = json_extract(c.metadata, '$.relationshipId')
      AND r.character_id = json_extract(c.metadata, '$.promptPresetId')
      AND r.deleted_at IS NULL
    JOIN relationship_memory_preferences p ON p.user_id = r.user_id
      AND p.relationship_id = r.id AND p.enabled = 1
    WHERE c.user_id = NEW.user_id AND c.id = NEW.conversation_id AND c.deleted_at IS NULL
  )
  ON CONFLICT(user_id, conversation_id) DO UPDATE SET
    generation = generation + 1, due_at = excluded.due_at,
    lease_until = NULL, attempts = 0, last_error = NULL;
END;

CREATE TRIGGER queue_memory_on_binding AFTER UPDATE OF metadata ON server_conversations
WHEN NEW.deleted_at IS NULL AND json_extract(NEW.metadata, '$.relationshipId') IS NOT NULL
  AND (json_extract(OLD.metadata, '$.relationshipId') IS NOT json_extract(NEW.metadata, '$.relationshipId'))
BEGIN
  INSERT INTO memory_extraction_jobs(user_id, conversation_id, generation, due_at)
  SELECT NEW.user_id, NEW.id, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 30000
  WHERE EXISTS (
    SELECT 1 FROM character_relationships r
    JOIN relationship_memory_preferences p ON p.user_id = r.user_id
      AND p.relationship_id = r.id AND p.enabled = 1
    WHERE r.user_id = NEW.user_id AND r.id = json_extract(NEW.metadata, '$.relationshipId')
      AND r.character_id = json_extract(NEW.metadata, '$.promptPresetId') AND r.deleted_at IS NULL
  )
  ON CONFLICT(user_id, conversation_id) DO UPDATE SET
    generation = generation + 1, due_at = excluded.due_at,
    lease_until = NULL, attempts = 0, last_error = NULL;
END;
