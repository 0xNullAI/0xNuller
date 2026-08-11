CREATE TABLE ai_usage_daily (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
  units INTEGER NOT NULL DEFAULT 0 CHECK (units >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, usage_day, kind)
);

CREATE INDEX idx_ai_usage_day ON ai_usage_daily(usage_day, kind);
