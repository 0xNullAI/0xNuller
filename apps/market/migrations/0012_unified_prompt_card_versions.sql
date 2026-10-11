-- A legacy prompt-only scenario is also a public Prompt card. Keep its
-- previous definition when the shared editor publishes a newer version.
DROP TRIGGER IF EXISTS archive_character_before_edit;

CREATE TRIGGER archive_scenario_before_edit
BEFORE UPDATE OF name, description, author, icon, tags, content ON items
WHEN OLD.type = 'scenario'
BEGIN
  INSERT OR IGNORE INTO character_item_versions
    (item_id, revision, name, description, author, icon, tags, content, archived_at)
  VALUES
    (OLD.id, OLD.revision, OLD.name, OLD.description, OLD.author, OLD.icon,
     OLD.tags, OLD.content, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;
