-- Private account content. Never included in public profiles or Market payloads.
CREATE TABLE personal_memories (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'person', 'event', 'note')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_personal_memories_owner
  ON personal_memories (user_id, deleted_at, updated_at, id);
