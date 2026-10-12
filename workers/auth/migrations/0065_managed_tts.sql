-- Generated audio is kept in private R2 for at most 24h. No prompt/text or
-- provider-signed URL is stored.
-- The existing wallet CHECK uses 'agent'; model_id and this table identify TTS until
-- the wallet kind can be migrated without rebuilding tables referenced by many FKs.
CREATE TABLE managed_tts_jobs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  reservation_key TEXT NOT NULL UNIQUE REFERENCES credit_reservations(idempotency_key) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('running','settlement_pending','succeeded','failed','needs_review')),
  max_credits INTEGER NOT NULL CHECK(max_credits > 0),
  charged_credits INTEGER,
  characters INTEGER,
  object_key TEXT,
  audio_expires_at INTEGER,
  price_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,id)
);
CREATE INDEX idx_managed_tts_jobs_recovery ON managed_tts_jobs(state,updated_at);
CREATE TRIGGER queue_managed_tts_audio_delete AFTER DELETE ON managed_tts_jobs
WHEN OLD.object_key IS NOT NULL BEGIN
  INSERT OR IGNORE INTO private_attachment_deletions(object_key,queued_at)
  VALUES(OLD.object_key,CAST(strftime('%s','now') AS INTEGER)*1000);
END;
