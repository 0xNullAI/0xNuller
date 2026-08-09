-- 账号下的用户数据：设置同步、内容库（波形 / 场景）、市场归属。
--
-- 在这之前账号只存身份，而账号弹窗上一直写着「用于同步波形库、场景与市场归属」。
-- 这份 migration 是把那句话变成真的。

-- ── 设置同步 ──
--
-- 按命名空间存一个 JSON blob，而不是给每种设置各开一张表。设置的形状还在变，
-- 一个命名空间加一个字段不该需要一次 migration；服务端不解释 payload 的内容，
-- 只负责存取和版本。
--
-- version 单调递增，客户端提交时带上自己看到的版本：对不上就是别的设备先写了，
-- 服务端拒绝并回传当前值，由客户端决定怎么办。没有它就是最后写的人赢，而
-- 「赢」的那台设备可能拿的是几天前的旧值。
--
-- **API Key 不进这张表。** 存了就等于 0xNullAI 成为第三方凭证的保管方，用户
-- 没有为此授权过。同步供应商、模型、人设，密钥留在本机。
CREATE TABLE user_settings (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace  TEXT NOT NULL,                 -- 'llm' | 'device-safety' | 'proxy' | 'ui'
  payload    TEXT NOT NULL,                 -- JSON
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, namespace)
);

-- ── 内容库（波形 / 场景）──
--
-- 一行一条内容，而不是整库一个 blob：两台设备各自加了一条时，整库 blob 只能
-- 二选一，一行一条则两条都在。
--
-- deleted_at 是软删除。硬删除在多设备下会复活：A 删掉、B 还没同步就上传自己的
-- 全量列表，那条又回来了。留一个墓碑，B 就知道那是被删的而不是它没有的。
CREATE TABLE user_content (
  id         TEXT NOT NULL,                 -- 客户端生成，跨设备稳定
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                 -- 'waveform' | 'scene'
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,                 -- JSON：波形是 frames，场景是 prompt
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, id)
);

-- 增量拉取按 updated_at 走：客户端只要「比我上次同步更新的」。
CREATE INDEX idx_content_user_kind ON user_content (user_id, kind, updated_at);

-- ── 市场归属 ──
--
-- 市场条目本身在 Market 自己的库里（另一个 Worker、另一个 D1），这里只记
-- 「哪个账号声明了哪个条目」。跨库外键做不到，也不需要——这张表回答的是
-- 「我上传过什么」，而 Market 回答的是「这个条目长什么样」。
--
-- edit_key_hash 是 Market 现有的匿名编辑凭证。认领时一并存下，账号从此成为
-- 找回入口：换了设备、本地 edit key 没了，也还能改自己的东西。
CREATE TABLE market_claims (
  item_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edit_key_hash TEXT,
  claimed_at    INTEGER NOT NULL,
  PRIMARY KEY (item_id)
);

CREATE INDEX idx_claims_user ON market_claims (user_id, claimed_at);
