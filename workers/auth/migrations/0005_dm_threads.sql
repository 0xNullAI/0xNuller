-- Direct messages: which conversations exist.
--
-- Purely additive — one new table and one index, no change to anything 0001-0004
-- created. It is safe to apply on top of the live database.
--
-- ## This table holds no messages, and never will
--
-- The conversation itself lives in Chat's Durable Object, which already has
-- history retention, media and the wire protocol. Putting the messages here as
-- well would be a second copy of all three, evolving separately, and it would put
-- the content of private conversations in the same database as the account
-- credentials. What this table holds is one bit: that a conversation exists.
--
-- ## Why it has to exist at all
--
-- Permission to talk is computed from user_follows and needs no storage — mutual
-- follow is an EXISTS against a primary key. But the DM list in the sidebar is not
-- "everyone you follow back". Without a record of which conversations were ever
-- opened, showing unread counts would mean asking Chat about every mutual contact
-- on every poll, which materialises a Durable Object per pair of people who have
-- never spoken. A row here is created the first time either side opens the
-- conversation, so the fan-out is over conversations rather than over the follow
-- graph.
--
-- ## Both directions, inserted together
--
-- Like user_follows this is one row per (viewer, other), but unlike user_follows
-- the pair is written on both sides at once, because a conversation is not
-- directional: if A opens one with B, B must see it in their list without having
-- done anything. Storing it as an unordered pair instead would make "my
-- conversations" a query that has to look in two columns, and every read path
-- would have to remember to.
--
-- ## Deletion
--
-- Hard deletes on both sides when someone blocks, matching the rest of contacts:
-- the block already removes the follows, and leaving the row would keep the
-- conversation listed for as long as the read filter happened to be right. Rows
-- also go with the account, via ON DELETE CASCADE — a conversation naming a
-- deleted user is still a record of that user.
--
-- Unfollowing does *not* delete the row. The read path filters to mutual follows,
-- so the conversation disappears from both lists on its own, and comes back if the
-- follow does — which is the behaviour someone who unfollowed by accident expects.
CREATE TABLE dm_threads (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, peer_id),
  CHECK (user_id <> peer_id)
);

-- "My conversations, newest first" is the only query this table serves. The
-- primary key answers the membership half but not the order, so without this the
-- list sorts on every read.
CREATE INDEX idx_dm_threads_user ON dm_threads (user_id, started_at DESC);
