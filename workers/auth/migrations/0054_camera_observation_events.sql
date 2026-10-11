-- Existing dialogue remains an ordinary message. Only the dedicated observation
-- endpoint may set this kind; neither legacy imports nor generic PUT can do so.
ALTER TABLE server_conversation_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'
  CHECK(kind IN ('message','camera_observation'));

CREATE TRIGGER camera_observation_conversation_revision
AFTER INSERT ON server_conversation_messages
WHEN NEW.kind='camera_observation'
BEGIN
  UPDATE server_conversations
  SET revision=revision+1,
      updated_at=MAX(updated_at+1,CAST(strftime('%s','now') AS INTEGER)*1000)
  WHERE user_id=NEW.user_id AND id=NEW.conversation_id AND deleted_at IS NULL;
END;
