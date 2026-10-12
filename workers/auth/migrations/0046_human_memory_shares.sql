-- A grant points to the owner's current account memory. No private text is copied.
-- The distinct chat key prevents an AI conversation's memory-access flag from
-- ever authorizing a human conversation.
CREATE TABLE human_memory_shares (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_kind TEXT NOT NULL CHECK (chat_kind IN ('dm','group')),
  chat_key TEXT NOT NULL,
  dm_peer_id TEXT,
  membership_version INTEGER,
  memory_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id,chat_kind,chat_key,memory_id),
  FOREIGN KEY (owner_id,memory_id) REFERENCES personal_memories(user_id,id) ON DELETE CASCADE,
  CHECK ((chat_kind='dm' AND dm_peer_id IS NOT NULL AND membership_version IS NULL)
      OR (chat_kind='group' AND dm_peer_id IS NULL AND membership_version IS NOT NULL))
);

CREATE INDEX idx_human_memory_shares_chat
  ON human_memory_shares(chat_kind,chat_key,enabled,owner_id);

-- Breaking either follow direction permanently closes both parties' DM grants.
-- Re-following later must require fresh, individual sharing decisions.
CREATE TRIGGER human_memory_shares_on_unfollow AFTER DELETE ON user_follows
BEGIN
  UPDATE human_memory_shares SET enabled=0,version=version+1,
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE chat_kind='dm' AND enabled=1
    AND ((owner_id=OLD.follower_id AND dm_peer_id=OLD.followee_id)
      OR (owner_id=OLD.followee_id AND dm_peer_id=OLD.follower_id));
END;

-- Removing one's own DM from the account index also closes that person's
-- grants, even when mutual follows remain and the other person's thread survives.
CREATE TRIGGER human_memory_shares_on_dm_leave AFTER DELETE ON dm_threads
BEGIN
  UPDATE human_memory_shares SET enabled=0,version=version+1,
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE chat_kind='dm' AND enabled=1
    AND owner_id=OLD.user_id AND dm_peer_id=OLD.peer_id;
END;
