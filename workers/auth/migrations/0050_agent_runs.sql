-- Execution records are distinct from user-editable agent_tasks plans. Browser
-- reports are audit hints, never server proof of a device or external action.
CREATE TABLE agent_runs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','completed','incomplete','needs_review','failed','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY(user_id,id),
  UNIQUE(user_id,conversation_id,request_id),
  FOREIGN KEY(user_id,conversation_id) REFERENCES server_conversations(user_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_runs_conversation ON agent_runs(user_id,conversation_id,created_at DESC,id);
CREATE INDEX agent_runs_stale ON agent_runs(status,updated_at) WHERE status='active';

CREATE TABLE agent_run_calls (
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed','succeeded','denied','failed','pending','unknown')),
  claim_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,run_id,call_id),
  FOREIGN KEY(user_id,run_id) REFERENCES agent_runs(user_id,id) ON DELETE CASCADE
);

CREATE TRIGGER agent_runs_on_conversation_delete AFTER UPDATE OF deleted_at ON server_conversations
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  DELETE FROM agent_runs WHERE user_id=NEW.user_id AND conversation_id=NEW.id;
END;
