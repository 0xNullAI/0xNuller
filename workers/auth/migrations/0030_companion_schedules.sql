-- Explicit user-authored companion messages; no autonomous device/model access.
CREATE TABLE companion_schedules (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 relationship_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 config_json TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version > 0),
 next_run_at INTEGER,
 occurrence_key TEXT,
 paused INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 deleted_at INTEGER,
 PRIMARY KEY(user_id,id),
 FOREIGN KEY(user_id,relationship_id) REFERENCES character_relationships(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,conversation_id) REFERENCES server_conversations(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_companion_schedules_due ON companion_schedules(paused,deleted_at,next_run_at);
CREATE TABLE companion_deliveries (
 user_id TEXT NOT NULL,
 schedule_id TEXT NOT NULL,
 occurrence_key TEXT NOT NULL,
 claim_token TEXT NOT NULL,
 message_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,schedule_id,occurrence_key),
 FOREIGN KEY(user_id,schedule_id) REFERENCES companion_schedules(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_companion_deliveries_frequency ON companion_deliveries(user_id,created_at);
CREATE TABLE companion_notifications (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 read_at INTEGER,
 PRIMARY KEY(user_id,id),
 FOREIGN KEY(user_id,conversation_id) REFERENCES server_conversations(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_companion_notifications_user ON companion_notifications(user_id,created_at,id);
