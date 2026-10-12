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
  reports     INTEGER NOT NULL DEFAULT 0, -- 仅保留旧版数据兼容；运行时不再读取
  hidden      INTEGER NOT NULL DEFAULT 0, -- 1=账户管理员隐藏
  ip_hash     TEXT,                        -- 上传来源哈希，用于限流与溯源
  created_at  INTEGER NOT NULL,           -- epoch ms
  edit_key_hash TEXT,                      -- 仅保留旧版数据；新内容使用账户归属
  edit_key_scheme INTEGER NOT NULL DEFAULT 1 CHECK (edit_key_scheme IN (1, 2)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)
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

CREATE INDEX IF NOT EXISTS idx_items_visible_views
  ON items (views DESC, created_at DESC, id)
  WHERE hidden = 0;

CREATE INDEX IF NOT EXISTS idx_items_visible_hot
  ON items ((views + downloads * 4) DESC, created_at DESC, id)
  WHERE hidden = 0;

CREATE INDEX IF NOT EXISTS idx_items_edit_key_scheme
  ON items (edit_key_scheme)
  WHERE edit_key_hash IS NOT NULL;

-- Monotonic publish boundary for latest-content cursor browsing.
CREATE TABLE item_publish_order (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL UNIQUE
);
CREATE TRIGGER item_publish_order_insert AFTER INSERT ON items BEGIN
  INSERT INTO item_publish_order(item_id) VALUES (NEW.id);
END;
CREATE TRIGGER item_publish_order_delete AFTER DELETE ON items BEGIN
  DELETE FROM item_publish_order WHERE item_id = OLD.id;
END;

-- Published Prompt card revisions are archived for all solo scenarios by 0012.
CREATE TABLE IF NOT EXISTS character_item_versions (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  name TEXT NOT NULL,
  description TEXT,
  author TEXT,
  icon TEXT,
  tags TEXT,
  content TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY(item_id, revision)
);

CREATE TRIGGER IF NOT EXISTS archive_scenario_before_edit
BEFORE UPDATE OF name, description, author, icon, tags, content ON items
WHEN OLD.type = 'scenario'
BEGIN
  INSERT OR IGNORE INTO character_item_versions
    (item_id, revision, name, description, author, icon, tags, content, archived_at)
  VALUES
    (OLD.id, OLD.revision, OLD.name, OLD.description, OLD.author, OLD.icon,
     OLD.tags, OLD.content, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

-- Immutable public-character images uploaded to Market R2 by a verified account.
CREATE TABLE IF NOT EXISTS character_portraits (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK(mime IN ('image/jpeg', 'image/png', 'image/webp')),
  status TEXT NOT NULL CHECK(status IN ('uploading', 'ready', 'deleting')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_character_portraits_owner_created
  ON character_portraits(owner_id, created_at DESC);

-- Owner-only original PNG/APNG and CHARX files for online drafts; no public item references.
CREATE TABLE IF NOT EXISTS character_container_drafts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK(mime IN ('image/png', 'application/zip')),
  byte_size INTEGER NOT NULL CHECK(byte_size > 0 AND byte_size <= 20000000),
  status TEXT NOT NULL CHECK(status IN ('uploading', 'ready', 'deleting')),
  created_at INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_character_container_drafts_owner_created
  ON character_container_drafts(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_character_container_drafts_cleanup
  ON character_container_drafts(last_checked_at, owner_id);

CREATE TABLE IF NOT EXISTS character_container_upload_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_character_container_upload_events_owner_time
  ON character_container_upload_events(owner_id, created_at);
CREATE TRIGGER IF NOT EXISTS character_container_upload_event
AFTER INSERT ON character_container_drafts
BEGIN
  INSERT INTO character_container_upload_events(id,owner_id,created_at)
  VALUES(NEW.id,NEW.owner_id,NEW.created_at);
END;

CREATE INDEX IF NOT EXISTS idx_items_character_portrait
  ON items(CASE WHEN json_valid(content) THEN json_extract(content, '$.portraitId') END)
  WHERE type = 'scenario' AND hidden = 0;

CREATE TRIGGER IF NOT EXISTS validate_character_portrait_insert
BEFORE INSERT ON items
WHEN CASE WHEN json_valid(NEW.content) THEN json_extract(NEW.content, '$.portraitId') END IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid character portrait')
  WHERE NOT EXISTS (
    SELECT 1 FROM character_portraits
    WHERE id = json_extract(NEW.content, '$.portraitId') AND status = 'ready'
  );
END;

CREATE TRIGGER IF NOT EXISTS validate_character_portrait_update
BEFORE UPDATE OF content ON items
WHEN CASE WHEN json_valid(NEW.content) THEN json_extract(NEW.content, '$.portraitId') END IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid character portrait')
  WHERE NOT EXISTS (
    SELECT 1 FROM character_portraits
    WHERE id = json_extract(NEW.content, '$.portraitId') AND status = 'ready'
  );
END;

-- Reports are private moderation records, never embedded in public cards or legacy reports counts.
CREATE TABLE IF NOT EXISTS item_reports (
 id TEXT PRIMARY KEY,
 item_id TEXT NOT NULL,
 item_name TEXT NOT NULL,
 reporter_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('unsafe','harassment','privacy','copyright','spam')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','hidden','dismissed','removed')),
 created_at INTEGER NOT NULL,
 resolved_at INTEGER,
 UNIQUE(item_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_item_reports_queue ON item_reports(status,created_at,id);
CREATE INDEX IF NOT EXISTS idx_item_reports_rate ON item_reports(reporter_id,created_at);
CREATE TRIGGER IF NOT EXISTS item_reports_on_hide AFTER UPDATE OF hidden ON items WHEN NEW.hidden=1
BEGIN
 UPDATE item_reports SET status='hidden',resolved_at=unixepoch()*1000 WHERE item_id=NEW.id AND status='pending';
END;
CREATE TRIGGER IF NOT EXISTS item_reports_on_delete AFTER DELETE ON items
BEGIN
 UPDATE item_reports SET status='removed',resolved_at=unixepoch()*1000 WHERE item_id=OLD.id AND status='pending';
END;

-- Private character discovery choices and bounded, account-deduped conversion events.
CREATE TABLE IF NOT EXISTS character_discovery_feedback (
  account_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('item','creator')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('not_interested','too_similar','hide_creator')),
  source_item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,target_kind,target_id)
);
CREATE INDEX IF NOT EXISTS idx_character_discovery_feedback_account_time
  ON character_discovery_feedback(account_id,created_at DESC);

CREATE TABLE IF NOT EXISTS character_conversion_events (
  account_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('detail_open','start')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,item_id,day,event_type)
);
CREATE INDEX IF NOT EXISTS idx_character_conversion_events_day_item
  ON character_conversion_events(day,item_id,event_type);

CREATE TABLE IF NOT EXISTS character_discovery_owner_checks (
  account_id TEXT PRIMARY KEY,
  last_checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_character_discovery_owner_checks_time
  ON character_discovery_owner_checks(last_checked_at,account_id);

-- Retired Market multiplayer templates cannot be reintroduced by old clients.
CREATE TRIGGER IF NOT EXISTS reject_multi_scene_insert
BEFORE INSERT ON items
WHEN NEW.type = 'multi-scene'
BEGIN
  SELECT RAISE(ABORT, 'multi-scene retired');
END;

CREATE TRIGGER IF NOT EXISTS reject_multi_scene_update
BEFORE UPDATE ON items
WHEN NEW.type = 'multi-scene'
BEGIN
  SELECT RAISE(ABORT, 'multi-scene retired');
END;
