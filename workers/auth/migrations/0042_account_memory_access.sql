-- Account-wide memories are private by default. A user explicitly opens them
-- to one owned AI conversation; relationship-scoped memories remain separate.
CREATE TABLE conversation_account_memory_access (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id),
  FOREIGN KEY (user_id, conversation_id) REFERENCES server_conversations(user_id, id) ON DELETE CASCADE
);
