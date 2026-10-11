-- Private AI chat attachments belong to a single account, conversation and user message.
-- Object bytes live in the existing private R2 binding; no public URL is stored.
CREATE TABLE private_conversation_attachments (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  message_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','ready')),
  kind TEXT NOT NULL CHECK(kind IN ('image','voice')),
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0),
  object_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CONSTRAINT attachment_message_state CHECK(
    (status='pending' AND message_id IS NULL) OR
    (status='ready' AND message_id IS NOT NULL)
  ),
  PRIMARY KEY(user_id,conversation_id,id),
  UNIQUE(user_id,conversation_id,message_id),
  FOREIGN KEY(user_id,conversation_id,message_id)
    REFERENCES server_conversation_messages(user_id,conversation_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_private_conversation_attachments_message
  ON private_conversation_attachments(user_id,conversation_id,message_id);

CREATE TABLE private_attachment_deletions (
  object_key TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL
);
CREATE TRIGGER queue_private_attachment_delete AFTER DELETE ON private_conversation_attachments BEGIN
  INSERT OR IGNORE INTO private_attachment_deletions(object_key,queued_at)
  VALUES(OLD.object_key,CAST(strftime('%s','now') AS INTEGER)*1000);
END;
