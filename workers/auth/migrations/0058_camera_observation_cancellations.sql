-- A cancelled observation ID cannot be resurrected by a delayed or retried POST.
CREATE TABLE camera_observation_cancellations (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  cancelled_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id, observation_id),
  FOREIGN KEY (user_id, conversation_id) REFERENCES server_conversations(user_id, id) ON DELETE CASCADE
);

CREATE TRIGGER camera_observation_conversation_retraction
AFTER DELETE ON server_conversation_messages
WHEN OLD.kind='camera_observation'
BEGIN
  UPDATE server_conversations
  SET revision=revision+1,
      updated_at=MAX(updated_at+1,CAST(strftime('%s','now') AS INTEGER)*1000)
  WHERE user_id=OLD.user_id AND id=OLD.conversation_id AND deleted_at IS NULL;
END;
