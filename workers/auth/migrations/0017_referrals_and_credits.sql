-- 邀请注册与活动 Credit。所有金额使用美分整数，避免浮点金额误差。
CREATE TABLE referral_codes (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- 为迁移前已有账户生成稳定邀请码；randomblob(6) 提供 48 位随机空间。
INSERT INTO referral_codes (user_id, code, created_at)
SELECT id, UPPER(HEX(randomblob(6))), created_at FROM users;

CREATE TABLE referrals (
  invitee_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'rewarded', 'rejected')),
  reward_cents    INTEGER NOT NULL CHECK (reward_cents > 0),
  created_at      INTEGER NOT NULL,
  qualified_at    INTEGER,
  CHECK (invitee_user_id <> inviter_user_id)
);

CREATE INDEX idx_referrals_inviter_status
  ON referrals (inviter_user_id, status, created_at DESC);

-- 只追加的额度账本。reference_id + kind 的唯一约束是奖励幂等性的最终保障。
CREATE TABLE credit_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('referral_reward', 'campaign_adjustment')),
  reference_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (user_id, kind, reference_id)
);

CREATE INDEX idx_credit_ledger_user_created
  ON credit_ledger (user_id, created_at DESC);
