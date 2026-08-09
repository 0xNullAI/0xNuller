-- 只有 Market Worker 验证过编辑凭证的归属才对用户可见。
-- 旧版本允许客户端直接声明 item_id，因此历史行全部保持未验证；真正持有
-- Market 编辑口令的人可以重新验证并取回尚未验证的记录。
ALTER TABLE market_claims ADD COLUMN verified_at INTEGER;
ALTER TABLE market_claims ADD COLUMN proof_method TEXT
  CHECK (proof_method IS NULL OR proof_method IN ('market-upload', 'market-edit-key'));

CREATE INDEX idx_claims_verified_user
  ON market_claims (user_id, claimed_at DESC)
  WHERE verified_at IS NOT NULL;

-- 相册写入先在 D1 占一个 0..59 的槽，再写 R2。唯一索引是并发配额的
-- 最终裁判；status='uploading' 的行也是失败对象的可重试清理任务。
ALTER TABLE user_photos ADD COLUMN slot INTEGER CHECK (slot BETWEEN 0 AND 59);
ALTER TABLE user_photos ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'
  CHECK (status IN ('uploading', 'ready'));

-- 为现存照片稳定分配槽位。若某个账号已经超过 60 张，发布前门禁会先拒绝
-- migration；这里不会悄悄丢数据。
UPDATE user_photos AS p
   SET slot = (
     SELECT COUNT(*) - 1
       FROM user_photos AS q
      WHERE q.user_id = p.user_id
        AND (q.created_at < p.created_at OR (q.created_at = p.created_at AND q.id <= p.id))
   )
 WHERE slot IS NULL;

CREATE UNIQUE INDEX idx_photos_user_slot ON user_photos (user_id, slot);
CREATE INDEX idx_photos_pending_cleanup
  ON user_photos (status, created_at)
  WHERE status = 'uploading';

-- 删除账号是跨 D1/R2 的工作流。标记先落 D1；R2 暂时失败时 cron 会继续，
-- 直到整个前缀清空后才硬删除 users 行。
CREATE TABLE account_deletions (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  requested_at INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error_at INTEGER
);

CREATE INDEX idx_account_deletions_requested
  ON account_deletions (requested_at, user_id);
