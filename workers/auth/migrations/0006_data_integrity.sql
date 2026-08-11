-- 数据平台读路径与对象引用完整性。

-- 一个 R2 object 只能属于一张照片记录；否则删掉其中一张会让另一张变成坏链接。
CREATE UNIQUE INDEX idx_photos_object_key ON user_photos (object_key);

-- 无 kind 与带 kind 的增量同步都以 (updated_at, id) 做稳定游标。原索引仍保留，
-- 因为它是生产历史的一部分；下面两个索引分别服务两种查询，避免 OR 让索引失效。
CREATE INDEX idx_content_sync_all
  ON user_content (user_id, updated_at, id);

CREATE INDEX idx_content_sync_kind
  ON user_content (user_id, kind, updated_at, id);

-- 定时清理按时间列执行；原两个限流索引都以用户名/IP 开头，无法服务全局过期清理。
CREATE INDEX idx_attempts_created_at ON login_attempts (created_at);
