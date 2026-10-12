-- Runtime monitoring before release: sanitized client error aggregates, per-Worker server error
-- counts and alert de-duplication. Additive only; no existing table changes.
--
-- Nothing here identifies a person. Client rows hold no account id, IP, session id or request
-- content; the intake table keeps only the peppered IP hash used for rate limiting, for one hour.
-- Retention: hourly aggregates and alert markers are deleted after 30 days by the daily cron.

-- One row per error signature per UTC hour. `signature` is a hash of the normalized message and
-- top stack frame; the descriptive columns hold the latest sanitized sample.
CREATE TABLE client_error_hourly (
  signature TEXT NOT NULL,
  hour_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  kind TEXT NOT NULL CHECK (kind IN ('error', 'unhandledrejection', 'boundary')),
  message TEXT NOT NULL,
  top_frame TEXT,
  stack TEXT,
  module_id TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('web', 'android')),
  product_version TEXT NOT NULL,
  build_id TEXT NOT NULL,
  route TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (signature, hour_start)
);
CREATE INDEX idx_client_error_hourly_hour ON client_error_hourly(hour_start);

-- Rate-limit ledger for the anonymous intake endpoint; pruned after one hour.
CREATE TABLE client_error_intake (
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_client_error_intake_ip ON client_error_intake(ip_hash, created_at);
CREATE INDEX idx_client_error_intake_created ON client_error_intake(created_at);

-- 5xx responses, thrown fetch handlers and failed crons per Worker per UTC hour.
CREATE TABLE server_error_hourly (
  worker TEXT NOT NULL CHECK (worker IN ('auth', 'chat', 'market', 'voice', 'llm-proxy')),
  hour_start INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('http_5xx', 'exception', 'scheduled')),
  count INTEGER NOT NULL CHECK (count > 0),
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (worker, hour_start, kind)
);
CREATE INDEX idx_server_error_hourly_hour ON server_error_hourly(hour_start);

-- Last time each alert condition emailed the admins; `signature:<hash>` rows alert once.
CREATE TABLE monitoring_alerts (
  alert_key TEXT PRIMARY KEY,
  last_sent_at INTEGER NOT NULL
);
