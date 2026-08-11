-- Bound public account creation by a stable, one-way source hash.
CREATE TABLE registration_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_registration_attempts_ip
ON registration_attempts (ip_hash, created_at);
