-- Existing account-authored memories remain active long-term personal content.
ALTER TABLE personal_memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'account' CHECK(scope IN ('account','relationship'));
ALTER TABLE personal_memories ADD COLUMN relationship_id TEXT;
ALTER TABLE personal_memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'long' CHECK(tier IN ('long','medium','history'));
ALTER TABLE personal_memories ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('suggested','active'));
ALTER TABLE personal_memories ADD COLUMN source_conversation_id TEXT;
ALTER TABLE personal_memories ADD COLUMN source_message_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_message_ids));
ALTER TABLE personal_memories ADD COLUMN expires_at INTEGER;
ALTER TABLE personal_memories ADD COLUMN confidence REAL;
CREATE INDEX idx_personal_memories_scope ON personal_memories(user_id,scope,relationship_id,state,deleted_at,updated_at);

-- Derived records never outlive a removed source. Tombstones prevent replay resurrection.
CREATE TRIGGER memories_on_conversation_delete AFTER UPDATE OF deleted_at ON server_conversations
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
 UPDATE personal_memories SET title='',content='',deleted_at=NEW.deleted_at,updated_at=NEW.deleted_at,version=version+1
 WHERE user_id=NEW.user_id AND source_conversation_id=NEW.id AND deleted_at IS NULL;
END;
CREATE TRIGGER memories_on_message_delete AFTER DELETE ON server_conversation_messages
BEGIN
 UPDATE personal_memories SET title='',content='',deleted_at=CAST(strftime('%s','now') AS INTEGER)*1000,
 updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,version=version+1
 WHERE user_id=OLD.user_id AND source_conversation_id=OLD.conversation_id AND deleted_at IS NULL
 AND EXISTS(SELECT 1 FROM json_each(source_message_ids) WHERE value=OLD.id);
END;
CREATE TRIGGER memories_on_message_change AFTER UPDATE OF content ON server_conversation_messages
WHEN NEW.content <> OLD.content
BEGIN
 UPDATE personal_memories SET title='',content='',deleted_at=CAST(strftime('%s','now') AS INTEGER)*1000,
 updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,version=version+1
 WHERE user_id=OLD.user_id AND source_conversation_id=OLD.conversation_id AND deleted_at IS NULL
 AND EXISTS(SELECT 1 FROM json_each(source_message_ids) WHERE value=OLD.id);
END;
CREATE TRIGGER memories_on_relationship_delete AFTER UPDATE OF deleted_at ON character_relationships
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
 UPDATE personal_memories SET title='',content='',deleted_at=NEW.deleted_at,updated_at=NEW.deleted_at,version=version+1
 WHERE user_id=NEW.user_id AND relationship_id=NEW.id AND deleted_at IS NULL;
END;
