-- Private, immutable imported card containers. They are never referenced by public items.
CREATE TABLE character_container_drafts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK(mime IN ('image/png', 'application/zip')),
  byte_size INTEGER NOT NULL CHECK(byte_size > 0 AND byte_size <= 20000000),
  status TEXT NOT NULL CHECK(status IN ('uploading', 'ready', 'deleting')),
  created_at INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_character_container_drafts_owner_created
  ON character_container_drafts(owner_id, created_at DESC);

CREATE INDEX idx_character_container_drafts_cleanup
  ON character_container_drafts(last_checked_at, owner_id);

-- Keep upload attempts for the daily limit even if an owner deletes a file immediately.
CREATE TABLE character_container_upload_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_character_container_upload_events_owner_time
  ON character_container_upload_events(owner_id, created_at);
CREATE TRIGGER character_container_upload_event
AFTER INSERT ON character_container_drafts
BEGIN
  INSERT INTO character_container_upload_events(id,owner_id,created_at)
  VALUES(NEW.id,NEW.owner_id,NEW.created_at);
END;
