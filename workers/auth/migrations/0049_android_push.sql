CREATE TABLE push_registrations (
  installation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider='fcm-fid'),
  platform TEXT NOT NULL CHECK(platform='android'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX push_registrations_user ON push_registrations(user_id);

CREATE TABLE push_deliveries (
  installation_id TEXT NOT NULL REFERENCES push_registrations(installation_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ai','dm','group')),
  target_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  sent_at INTEGER,
  dead_at INTEGER,
  PRIMARY KEY(installation_id,kind,target_id,event_id)
);
CREATE INDEX push_deliveries_due ON push_deliveries(next_attempt_at) WHERE sent_at IS NULL AND dead_at IS NULL;
