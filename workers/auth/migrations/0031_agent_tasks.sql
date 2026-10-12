CREATE TABLE agent_tasks (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 id TEXT NOT NULL, conversation_id TEXT NOT NULL, title TEXT NOT NULL,
 steps_json TEXT NOT NULL CHECK(json_valid(steps_json)),
 status TEXT NOT NULL CHECK(status IN ('planned','active','paused','completed')),
 version INTEGER NOT NULL CHECK(version>0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
 PRIMARY KEY(user_id,id),
 FOREIGN KEY(user_id,conversation_id) REFERENCES server_conversations(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_tasks_conversation ON agent_tasks(user_id,conversation_id,deleted_at,updated_at);
CREATE TABLE conversation_text_files (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 id TEXT NOT NULL, conversation_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
 content TEXT NOT NULL, byte_length INTEGER NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 created_at INTEGER NOT NULL, deleted_at INTEGER,
 PRIMARY KEY(user_id,id),
 FOREIGN KEY(user_id,conversation_id) REFERENCES server_conversations(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_conversation_files_owner ON conversation_text_files(user_id,conversation_id,deleted_at,created_at);
CREATE TRIGGER workspace_on_conversation_delete AFTER UPDATE OF deleted_at ON server_conversations
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
 UPDATE agent_tasks SET title='',steps_json='[]',deleted_at=NEW.deleted_at,updated_at=NEW.deleted_at,version=version+1
 WHERE user_id=NEW.user_id AND conversation_id=NEW.id AND deleted_at IS NULL;
 UPDATE conversation_text_files SET name='',content='',byte_length=0,deleted_at=NEW.deleted_at,version=version+1
 WHERE user_id=NEW.user_id AND conversation_id=NEW.id AND deleted_at IS NULL;
END;
