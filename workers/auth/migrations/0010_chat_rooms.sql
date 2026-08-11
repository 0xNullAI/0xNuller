-- Chat room membership belongs to the account so the Web and Android shells
-- show the same sidebar. Room ownership/lifecycle is enforced by Chat separately.
CREATE TABLE user_chat_rooms (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  owner_key  TEXT,
  joined_at  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, code)
);

CREATE INDEX idx_user_chat_rooms_updated ON user_chat_rooms (user_id, updated_at DESC);
