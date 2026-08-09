-- 编辑口令与管理员口令解耦。
--
-- 旧数据的 edit_key_hash 是 SHA-256(editKey:ADMIN_KEY)，标记为 scheme 1；
-- 新上传一律使用独立的 MARKET_EDIT_PEPPER（scheme 2）。旧条目在下一次成功
-- 校验编辑口令时原地升级，因此 ADMIN_KEY 之后可以安全轮换，而无需停机重写。
ALTER TABLE items ADD COLUMN edit_key_scheme INTEGER NOT NULL DEFAULT 1
  CHECK (edit_key_scheme IN (1, 2));

CREATE INDEX idx_items_edit_key_scheme
  ON items (edit_key_scheme)
  WHERE edit_key_hash IS NOT NULL;
