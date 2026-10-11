-- Video replies are staged outside the transcript until the originating client
-- confirms it is still active. Cancellation wins over a late confirmation.
CREATE TABLE video_reply_staging (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  reply_id TEXT NOT NULL,
  source_message_id TEXT,
  content TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','cancelled','committed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,conversation_id,reply_id),
  FOREIGN KEY(user_id,conversation_id) REFERENCES server_conversations(user_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_video_reply_staging_expiry ON video_reply_staging(updated_at,state);

CREATE TRIGGER video_reply_conversation_revision
AFTER INSERT ON server_conversation_messages
WHEN EXISTS (
  SELECT 1 FROM video_reply_staging
  WHERE user_id=NEW.user_id AND conversation_id=NEW.conversation_id
    AND reply_id=NEW.id AND state='pending'
)
BEGIN
  UPDATE server_conversations
  SET revision=revision+1,
      updated_at=MAX(updated_at+1,CAST(strftime('%s','now') AS INTEGER)*1000)
  WHERE user_id=NEW.user_id AND id=NEW.conversation_id AND deleted_at IS NULL;
END;
