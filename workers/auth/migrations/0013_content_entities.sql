-- Content bodies are global entities; accounts keep only lightweight references.
-- Legacy ids were only unique inside one account, so the migrated entity id is
-- namespaced by its owner while the public/client id remains unchanged on the ref.
CREATE TABLE content_entities (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('waveform', 'scene')),
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE user_content_refs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_id TEXT NOT NULL REFERENCES content_entities(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  hidden_at  INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, content_id),
  UNIQUE (user_id, client_id)
);

CREATE INDEX idx_content_refs_sync
  ON user_content_refs (user_id, updated_at, client_id);
CREATE INDEX idx_content_entities_owner_kind
  ON content_entities (owner_id, kind, updated_at);

CREATE TABLE user_content_preferences (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('waveform', 'scene')),
  selected_id        TEXT,
  hidden_builtin_ids TEXT NOT NULL DEFAULT '[]',
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

INSERT INTO content_entities (id, owner_id, kind, name, payload, created_at, updated_at)
SELECT user_id || ':' || id, user_id, kind, name, payload, created_at, updated_at
FROM user_content;

INSERT INTO user_content_refs
  (user_id, content_id, client_id, sort_order, hidden_at, deleted_at, created_at, updated_at)
SELECT user_id, user_id || ':' || id, id, 0, NULL, deleted_at, created_at, updated_at
FROM user_content;
