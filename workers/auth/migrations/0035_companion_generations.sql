CREATE TABLE companion_generations (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 schedule_id TEXT NOT NULL,
 occurrence_key TEXT NOT NULL,
 schedule_version INTEGER NOT NULL,
 reservation_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('submitted','ready','delivered','failed')),
 content TEXT NOT NULL DEFAULT '',
 credits INTEGER NOT NULL,
 price_version TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,schedule_id,occurrence_key,schedule_version),
 FOREIGN KEY(user_id,schedule_id) REFERENCES companion_schedules(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_companion_generations_state ON companion_generations(state,updated_at);
-- A single in-flight proactive turn per account bounds provider spend under overlapping cron.
CREATE UNIQUE INDEX idx_companion_generation_active_account ON companion_generations(user_id)
 WHERE state IN ('submitted','ready');
