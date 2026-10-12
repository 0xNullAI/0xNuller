-- A legacy prompt-only scenario is also a public Prompt card. Keep its
-- previous definition when the shared editor publishes a newer version.
DROP TRIGGER IF EXISTS archive_character_before_edit;

-- Archive only a real change, and keep a bounded history per card: an unchanged save must
-- not copy a large card again, and repeated edits must not grow the database without limit.
CREATE TRIGGER archive_scenario_before_edit
BEFORE UPDATE OF name, description, author, icon, tags, content ON items
WHEN OLD.type = 'scenario'
  AND (OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description
    OR OLD.author IS NOT NEW.author OR OLD.icon IS NOT NEW.icon
    OR OLD.tags IS NOT NEW.tags OR OLD.content IS NOT NEW.content)
BEGIN
  INSERT OR IGNORE INTO character_item_versions
    (item_id, revision, name, description, author, icon, tags, content, archived_at)
  VALUES
    (OLD.id, OLD.revision, OLD.name, OLD.description, OLD.author, OLD.icon,
     OLD.tags, OLD.content, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  DELETE FROM character_item_versions
  WHERE item_id = OLD.id AND revision NOT IN (
    SELECT revision FROM character_item_versions WHERE item_id = OLD.id
    ORDER BY revision DESC LIMIT 50
  );
END;
