-- 个人资料。
--
-- 全部字段可空：这是成人向产品，任何一项都不该是使用门槛。什么都不填的账号
-- 必须完全可用。
--
-- 关于隐私，这里有两个刻意的取舍，不是保守而是这类用户的实际风险：
--
-- 1. **location 只到地区级，不存街道地址。** 对这个品类的用户，一次库泄露里
--    出现家庭住址意味着人身风险，而不只是骚扰。个人资料里没有任何功能需要精确
--    到门牌号——「同城」这类需求地区级就够了。字段长度上限 60 也是这个用意。
--
-- 2. **visibility 默认 private。** 默认公开会让人在还没想清楚之前就把信息暴露
--    出去，而这类信息一旦被别人看到过就收不回来。要被看见得是一次明确的动作。
CREATE TABLE user_profiles (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  avatar_url  TEXT,                          -- 头像；空则由用户名生成
  bio         TEXT,                          -- 简介
  birth_date  TEXT,                          -- YYYY-MM-DD；用于成年确认与生日展示
  location    TEXT,                          -- 地区级（城市/省份），不是街道地址
  links       TEXT,                          -- JSON 数组：个人主页等
  visibility  TEXT NOT NULL DEFAULT 'private', -- 'private' | 'public'
  updated_at  INTEGER NOT NULL
);

-- 相册。
--
-- 单独一张表而不是 profile 里的 JSON：条目会增删，一行一条才能单独删除、
-- 单独设可见性，也才能在不读整个相册的情况下分页。
--
-- object_key 指向 R2，库里不存图片本身。删除时要连带删 R2 对象，否则「删掉了」
-- 只是列表里看不见，文件还在——对这类内容，那不叫删除。
CREATE TABLE user_photos (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key  TEXT NOT NULL,                 -- R2 对象键
  caption     TEXT,
  visibility  TEXT NOT NULL DEFAULT 'private',
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_photos_user ON user_photos (user_id, created_at DESC);
