-- Reuses existing wallet/reservations, with model_id and ledger metadata for media attribution.
CREATE TABLE media_jobs (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 relationship_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('image','selfie','video')),
 prompt TEXT NOT NULL,
 request_json TEXT NOT NULL,
 credits INTEGER NOT NULL CHECK(credits>0),
 price_version TEXT NOT NULL,
 reservation_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('queued','submitting','processing','storing','succeeded','failed','submission_unknown','deleting','deleted')),
 upstream_id TEXT,
 object_key TEXT NOT NULL,
 photo_id TEXT,
 mime TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 next_run_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,id)
);
CREATE INDEX idx_media_jobs_due ON media_jobs(state,next_run_at);
CREATE INDEX idx_media_jobs_user ON media_jobs(user_id,created_at DESC,id);
