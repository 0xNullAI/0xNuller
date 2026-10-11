-- Account-owned discovery choices; never visible to publishers or public item APIs.
CREATE TABLE character_discovery_feedback (
  account_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('item','creator')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('not_interested','too_similar','hide_creator')),
  source_item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,target_kind,target_id)
);
CREATE INDEX idx_character_discovery_feedback_account_time
  ON character_discovery_feedback(account_id,created_at DESC);

-- A click on a public card and a completed "start chat" action, deduped per account/card/day.
-- No relationship ID, conversation ID, message, memory, or author-facing per-user data.
CREATE TABLE character_conversion_events (
  account_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('detail_open','start')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,item_id,day,event_type)
);
CREATE INDEX idx_character_conversion_events_day_item
  ON character_conversion_events(day,item_id,event_type);

-- Bounded daily account audit for private Market preferences/events after Auth deletion.
CREATE TABLE character_discovery_owner_checks (
  account_id TEXT PRIMARY KEY,
  last_checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_character_discovery_owner_checks_time
  ON character_discovery_owner_checks(last_checked_at,account_id);
