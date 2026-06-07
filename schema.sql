-- DG-Market D1 schema
-- 一张表存两类条目（波形 / 场景），content 为 JSON 文本。

CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,          -- uuid
  type        TEXT NOT NULL,             -- 'waveform' | 'scenario'
  name        TEXT NOT NULL,
  description TEXT,
  author      TEXT,                       -- 上传者昵称，可空
  icon        TEXT,                       -- 场景 emoji 图标
  tags        TEXT,                       -- 逗号分隔
  content     TEXT NOT NULL,              -- JSON：波形 {frames,pulse?} 或场景 {prompt}
  downloads   INTEGER NOT NULL DEFAULT 0,
  reports     INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0, -- 1=管理员隐藏
  ip_hash     TEXT,                        -- 上传来源哈希，用于限流与溯源
  created_at  INTEGER NOT NULL            -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_items_browse
  ON items (type, hidden, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_items_ip
  ON items (ip_hash, created_at);
