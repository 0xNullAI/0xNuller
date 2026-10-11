-- Public conversation metadata and individually addressable messages. Old clients
-- retain agent_sessions; authenticated reads lazily validate and import its rows.
CREATE TABLE server_conversations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  mutation_id TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_server_conversations_cursor ON server_conversations(user_id, updated_at, id);
CREATE TABLE server_conversation_messages (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(user_id,conversation_id,id),
  FOREIGN KEY(user_id,conversation_id) REFERENCES server_conversations(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_conversation_messages_order ON server_conversation_messages(user_id,conversation_id,position,id);
