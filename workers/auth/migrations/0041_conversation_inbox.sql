-- Sequence allocation is shared by every writer, including scheduled messages.
ALTER TABLE server_conversations ADD COLUMN last_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE server_conversations ADD COLUMN read_sequence INTEGER;
ALTER TABLE server_conversations ADD COLUMN last_message_at INTEGER;
ALTER TABLE server_conversation_messages ADD COLUMN sequence INTEGER;
UPDATE server_conversation_messages AS m SET sequence=ranked.seq
FROM (SELECT user_id,conversation_id,id,ROW_NUMBER() OVER (
 PARTITION BY user_id,conversation_id ORDER BY position,id) AS seq
 FROM server_conversation_messages) AS ranked
WHERE ranked.user_id=m.user_id AND ranked.conversation_id=m.conversation_id AND ranked.id=m.id;
UPDATE server_conversations SET last_sequence=COALESCE((SELECT MAX(sequence)
 FROM server_conversation_messages WHERE user_id=server_conversations.user_id
 AND conversation_id=server_conversations.id),0);
CREATE UNIQUE INDEX idx_conversation_sequence ON server_conversation_messages(user_id,conversation_id,sequence);
CREATE INDEX idx_conversation_inbox ON server_conversations(user_id,last_message_at,id);
CREATE TRIGGER conversation_message_sequence AFTER INSERT ON server_conversation_messages BEGIN
 UPDATE server_conversations SET last_sequence=last_sequence+1,
 last_message_at=(CASE WHEN NEW.role IN ('user','assistant') AND mutation_id NOT LIKE 'legacy:%'
 THEN MAX(COALESCE(last_message_at,0),CAST(strftime('%s','now') AS INTEGER)*1000)
 ELSE last_message_at END) WHERE user_id=NEW.user_id AND id=NEW.conversation_id;
 UPDATE server_conversation_messages SET sequence=(SELECT last_sequence FROM server_conversations
 WHERE user_id=NEW.user_id AND id=NEW.conversation_id)
 WHERE user_id=NEW.user_id AND conversation_id=NEW.conversation_id AND id=NEW.id;
END;
