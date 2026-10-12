-- Private relationship identity stays separate from public character/scene content.
CREATE TABLE character_relationships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  ai_nickname TEXT NOT NULL,
  user_preferred_name TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  notes TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX idx_character_relationships_active_character
  ON character_relationships (user_id, character_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_character_relationships_owner
  ON character_relationships (user_id, deleted_at, updated_at, id);
