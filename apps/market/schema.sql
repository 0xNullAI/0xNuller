-- 只供阅读的 schema 快照。真实建库与升级一律使用 migrations/，不要直接 execute 本文件。
-- DG-Market 一张表存波形 / 场景 / 多场景，content 为 JSON 文本。

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
  views       INTEGER NOT NULL DEFAULT 0,
  reports     INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0, -- 1=管理员隐藏
  ip_hash     TEXT,                        -- 上传来源哈希，用于限流与溯源
  created_at  INTEGER NOT NULL,           -- epoch ms
  edit_key_hash TEXT,                      -- 上传时所设编辑口令的哈希，空=公开可编辑
  edit_key_scheme INTEGER NOT NULL DEFAULT 1 CHECK (edit_key_scheme IN (1, 2))
);

CREATE INDEX IF NOT EXISTS idx_items_browse
  ON items (type, hidden, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_items_ip
  ON items (ip_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_items_visible_new
  ON items (created_at DESC, id)
  WHERE hidden = 0;

CREATE INDEX IF NOT EXISTS idx_items_visible_popular
  ON items (downloads DESC, created_at DESC, id)
  WHERE hidden = 0;

CREATE INDEX IF NOT EXISTS idx_items_edit_key_scheme
  ON items (edit_key_scheme)
  WHERE edit_key_hash IS NOT NULL;
