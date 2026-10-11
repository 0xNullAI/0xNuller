-- A recorded voice clip is billed separately from realtime Voice. The wallet's
-- legacy usage_kind CHECK is bridged with 'agent'; model_id and this table are
-- authoritative for ASR attribution until the wallet enum is migrated safely.
CREATE TABLE voice_attachment_asr_jobs (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  reservation_key TEXT NOT NULL UNIQUE REFERENCES credit_reservations(idempotency_key) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('running','settlement_pending','succeeded','failed','needs_review')),
  max_credits INTEGER NOT NULL CHECK(max_credits > 0),
  charged_credits INTEGER,
  seconds INTEGER,
  transcript TEXT,
  price_version TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,conversation_id,attachment_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_voice_attachment_asr_jobs_recovery
  ON voice_attachment_asr_jobs(state,updated_at);
CREATE TRIGGER redact_asr_after_attachment_delete
AFTER DELETE ON private_conversation_attachments BEGIN
  UPDATE voice_attachment_asr_jobs SET transcript=NULL,
    state=CASE WHEN state IN ('running','settlement_pending') THEN 'needs_review' ELSE state END,
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
  WHERE user_id=OLD.user_id AND conversation_id=OLD.conversation_id AND attachment_id=OLD.id;
END;
