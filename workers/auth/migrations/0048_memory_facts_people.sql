-- Explicit fact replacement and private person identity. No inferred identity merge.
ALTER TABLE personal_memories ADD COLUMN superseded_by_id TEXT;
ALTER TABLE personal_memories ADD COLUMN person_id TEXT;
CREATE INDEX idx_personal_memories_person ON personal_memories(user_id,relationship_id,person_id,deleted_at);

CREATE TABLE memory_people (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL CHECK(json_valid(aliases_json) AND json_type(aliases_json)='array'),
  normalized_aliases_json TEXT NOT NULL CHECK(json_valid(normalized_aliases_json) AND json_type(normalized_aliases_json)='array'),
  version INTEGER NOT NULL CHECK(version>0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY(user_id,id),
  FOREIGN KEY(user_id,relationship_id) REFERENCES character_relationships(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_memory_people_scope ON memory_people(user_id,relationship_id,deleted_at,updated_at);

CREATE TRIGGER validate_memory_person_insert BEFORE INSERT ON personal_memories
WHEN NEW.person_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM memory_people p WHERE p.user_id=NEW.user_id AND p.id=NEW.person_id
    AND p.relationship_id=NEW.relationship_id AND NEW.scope='relationship' AND p.deleted_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'memory person must belong to the same active relationship'); END;
CREATE TRIGGER validate_memory_person_update BEFORE UPDATE OF person_id ON personal_memories
WHEN NEW.person_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM memory_people p WHERE p.user_id=NEW.user_id AND p.id=NEW.person_id
    AND p.relationship_id=NEW.relationship_id AND NEW.scope='relationship' AND p.deleted_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'memory person must belong to the same active relationship'); END;

-- A replacement remains a tombstone link even if the newer fact is later erased.
-- The old fact must never silently return to the model or a human share.
CREATE TRIGGER validate_memory_supersession BEFORE UPDATE OF superseded_by_id ON personal_memories
WHEN NEW.superseded_by_id IS NOT OLD.superseded_by_id
BEGIN
  SELECT CASE WHEN OLD.superseded_by_id IS NOT NULL OR NEW.superseded_by_id IS NULL
    OR NEW.superseded_by_id=OLD.id OR OLD.deleted_at IS NOT NULL OR OLD.state<>'active'
    OR NOT EXISTS (
      SELECT 1 FROM personal_memories newer
      WHERE newer.user_id=OLD.user_id AND newer.id=NEW.superseded_by_id
        AND newer.scope=OLD.scope AND newer.relationship_id IS OLD.relationship_id
        AND newer.state='active' AND newer.deleted_at IS NULL
        AND newer.superseded_by_id IS NULL
        AND (newer.expires_at IS NULL OR newer.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000)
    ) THEN RAISE(ABORT,'invalid memory supersession') END;
END;

CREATE TRIGGER memory_people_on_relationship_delete AFTER UPDATE OF deleted_at ON character_relationships
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  UPDATE memory_people SET display_name='',aliases_json='[]',normalized_aliases_json='[]',
    deleted_at=NEW.deleted_at,updated_at=NEW.deleted_at,version=version+1
  WHERE user_id=NEW.user_id AND relationship_id=NEW.id AND deleted_at IS NULL;
END;
CREATE TRIGGER memory_person_unlink_on_delete AFTER UPDATE OF deleted_at ON memory_people
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  UPDATE personal_memories SET person_id=NULL,updated_at=NEW.deleted_at,version=version+1
  WHERE user_id=NEW.user_id AND relationship_id=NEW.relationship_id AND person_id=NEW.id
    AND deleted_at IS NULL;
END;
