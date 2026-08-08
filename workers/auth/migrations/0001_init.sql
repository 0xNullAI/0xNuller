-- 账号与会话。
--
-- 刻意不存邮箱为必填：这是成人向产品，要求真实邮箱是一道实质门槛。邮箱是可选的
-- 找回手段，不填则忘记密码等于失去账号——注册时会明确告知。
CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- uuid
  username      TEXT NOT NULL UNIQUE,       -- 大小写不敏感，存小写
  display_name  TEXT NOT NULL,              -- 展示用，保留用户输入的大小写
  password_hash TEXT NOT NULL,              -- PBKDF2-SHA256，格式见 password.ts
  email         TEXT,                       -- 可选，仅用于找回
  created_at    INTEGER NOT NULL,
  -- 封禁。理由对用户可见，避免「莫名其妙用不了」。
  banned_at     INTEGER,
  ban_reason    TEXT
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,             -- 存哈希而不是原始 token：库泄露也不能直接冒用
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  -- 便于用户在「我的设备」里辨认并单独吊销
  user_agent  TEXT
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- 登录尝试，用于限流与撞库检测。按用户名与 IP 哈希双维度。
CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_attempts_username ON login_attempts (username, created_at);
CREATE INDEX idx_attempts_ip ON login_attempts (ip_hash, created_at);
