-- 已发布 migration：内容不可改写。
-- 0000 为新空库建立旧版基础表；生产中已记录本文件的库会直接跳过它。
-- D1 不支持 ADD COLUMN IF NOT EXISTS，因此迁移前必须确认旧库的 migration 账本。
ALTER TABLE items ADD COLUMN edit_key_hash TEXT;
