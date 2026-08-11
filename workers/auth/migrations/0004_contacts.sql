-- Contacts: following, and the blocking that has to ship in the same migration.
--
-- ## A follow is directional, and that is the entire model
--
-- "A follows B" is one row. "B follows A" is a different row. A **contact** is
-- not stored anywhere: it is the name for both rows existing, and it is
-- computed at read time with one EXISTS against the primary key.
--
-- There is deliberately no friendship / contacts table. It would hold a fact
-- this table already holds, and two copies of one fact drift: the friend list
-- and the follow graph end up disagreeing, and at that point nobody can say
-- which of them is the truth. Denormalising mutuality buys nothing either —
-- the EXISTS is a primary-key probe.
--
-- ## created_at, and nothing else
--
-- A follow has no editable state; it exists or it does not. created_at exists
-- so a list has a stable order (newest first) — without it "who I follow" comes
-- back in whatever order the storage engine feels like, which changes between
-- requests and makes pagination meaningless.
--
-- Unfollowing and unblocking are hard deletes, not tombstones like
-- user_content's. The follow graph is never merged across devices — clients
-- always read it from here — so a tombstone would buy no correctness. What it
-- would create is a permanent record of who someone used to follow, and in
-- this product category that history is exactly the thing not to keep.
--
-- ## Why blocking is here rather than in a later migration
--
-- Blocking carries more weight in an adult product than it does elsewhere:
-- the person being blocked is often a specific individual the user wants gone,
-- and "gone" has to mean gone rather than hidden. Retrofitting it onto a live
-- follow graph is the bad version of this work — every existing follow has to
-- be re-examined against a block table that did not exist when it was written,
-- and until that is finished the enforcement gap is invisible from the outside.
-- Shipping the two together means there is never a window where a follow
-- predates the rules.

-- ── Follows ──
--
-- The CHECK is defence in depth. The endpoint refuses a self-follow with a
-- readable message, and this makes it impossible to store one even if some
-- future call site forgets — a self-follow would otherwise show up as the user
-- appearing in their own follower list, which reads as a bug in the product
-- rather than a missing validation.
--
-- ON DELETE CASCADE on both sides: deleting an account has to take the graph
-- with it. Users here care intensely about whether deletion is real, and rows
-- naming a deleted user are still rows naming that user.
CREATE TABLE user_follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

-- The primary key already answers "does A follow B" and "who does A follow",
-- but not in created_at order — reading a user's own following list would sort
-- every time. This index makes that read an ordered range scan.
CREATE INDEX idx_follows_follower ON user_follows (follower_id, created_at DESC);

-- The reverse direction has no covering index from the primary key at all:
-- "who follows B" would be a full table scan, which is the one query that grows
-- without bound for a popular account.
CREATE INDEX idx_follows_followee ON user_follows (followee_id, created_at DESC);

-- ── Blocks ──
--
-- Stored directionally (who blocked whom, so it can be undone by its owner) but
-- **enforced symmetrically**: a block hides each party from the other. Enforcing
-- it in one direction only leaves the blocked person able to watch the blocker's
-- profile and follower list, which is precisely the situation blocking exists to
-- end.
--
-- Consequences enforced by the endpoints rather than by the schema, listed here
-- because they are the reason this table exists:
--   * blocking removes any follow in **both** directions immediately — a block
--     that leaves the existing follow in place is not a block
--   * someone you blocked cannot follow you, and gets the same 404 as a
--     nonexistent user; telling a person they have been blocked invites
--     retaliation, and here retaliation means targeted harassment
--   * blocked users are filtered out of every list, in both directions
--
-- Unblocking does not restore the follows the block removed. They were deleted
-- by an intentional act, and silently resurrecting a follow the user got rid of
-- is a worse surprise than having to follow again.
CREATE TABLE user_blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- "Has this person blocked me" is asked on every follow attempt and on every
-- list read; the primary key only answers the blocker's direction.
CREATE INDEX idx_blocks_blocked ON user_blocks (blocked_id, blocker_id);
