-- Private online character drafts belong to the account and disappear with it.
CREATE TABLE character_drafts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  content TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, item_key)
);
