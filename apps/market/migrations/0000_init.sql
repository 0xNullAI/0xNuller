-- DG-Market 在引入 migration 账本前的基础表结构。
--
-- 这个文件晚于生产中的 0001 才加入，因此必须保持幂等：已存在的库执行它时
-- 不改变表结构；空库则先建立旧版基础表，再由不可变的 0001 增加 edit_key_hash。
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  author      TEXT,
  icon        TEXT,
  tags        TEXT,
  content     TEXT NOT NULL,
  downloads   INTEGER NOT NULL DEFAULT 0,
  views       INTEGER NOT NULL DEFAULT 0,
  reports     INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_browse ON items (type, hidden, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_ip ON items (ip_hash, created_at);
