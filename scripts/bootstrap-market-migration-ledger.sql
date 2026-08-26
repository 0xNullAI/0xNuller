-- Production Market predates Wrangler's migration ledger. Run this file only after
-- manually confirming from a backup or read-only database inspection that:
--   * items has the raw schema through edit_key_hash
--   * d1_migrations does not exist
--
-- This idempotent ledger bootstrap changes no item row or index. It only records the two
-- schema steps already present so Wrangler can safely apply 0002+ without replaying ALTER.
CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0000_init.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_add_edit_key.sql');
