-- Agent conversations are account-owned content, but unlike settings they are
-- unbounded and independently mutable. Keeping one row per conversation avoids
-- the 256 KiB settings-blob ceiling and lets devices merge without overwriting
-- unrelated chats.
CREATE TABLE agent_sessions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  client_updated_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_agent_sessions_sync
  ON agent_sessions (user_id, updated_at, id);
