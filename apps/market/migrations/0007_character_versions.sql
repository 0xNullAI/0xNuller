-- Published card edits keep their previous public definition for existing companions.
-- Existing rows begin at revision 1; no content is rewritten by this migration.
ALTER TABLE items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);

CREATE TABLE character_item_versions (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  name TEXT NOT NULL,
  description TEXT,
  author TEXT,
  icon TEXT,
  tags TEXT,
  content TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY(item_id, revision)
);

CREATE TRIGGER archive_character_before_edit
BEFORE UPDATE OF name, description, author, icon, tags, content ON items
WHEN OLD.type = 'scenario' AND json_valid(OLD.content)
  AND json_extract(OLD.content, '$.characterCard.schemaVersion') = 1
BEGIN
  INSERT OR IGNORE INTO character_item_versions
    (item_id, revision, name, description, author, icon, tags, content, archived_at)
  VALUES
    (OLD.id, OLD.revision, OLD.name, OLD.description, OLD.author, OLD.icon,
     OLD.tags, OLD.content, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;
