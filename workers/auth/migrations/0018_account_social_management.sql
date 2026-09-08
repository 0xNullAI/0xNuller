-- 社交安全举报。只保留处理所需的结构化原因与简短补充说明。
CREATE TABLE user_reports (
  id               TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason           TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'impersonation', 'unsafe', 'other')),
  details          TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at       INTEGER NOT NULL,
  reviewed_at      INTEGER,
  CHECK (reporter_user_id <> reported_user_id)
);

CREATE INDEX idx_user_reports_status_created
  ON user_reports (status, created_at DESC);

-- 同一举报人对同一账号只保留一条待处理记录，避免重复点击制造队列噪声。
CREATE UNIQUE INDEX idx_user_reports_open_pair
  ON user_reports (reporter_user_id, reported_user_id)
  WHERE status = 'open';
