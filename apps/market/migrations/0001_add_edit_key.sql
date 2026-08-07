-- 为已存在的 D1 库新增「编辑口令哈希」列。
-- 新库由 schema.sql 直接建好该列，无需本迁移。
-- 注意：D1 不支持 ADD COLUMN IF NOT EXISTS，重复执行会报「duplicate column name」，属一次性操作。
ALTER TABLE items ADD COLUMN edit_key_hash TEXT;
