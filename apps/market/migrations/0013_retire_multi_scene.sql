-- Multiplayer Market templates are retired. Public character and scene cards
-- continue to share `type=scenario`; their content.kind distinguishes them.
-- Legacy prompt-only cards are inferred as scenes at read time, so no historical
-- content or revision is rewritten by this migration.
--
-- Old multiplayer rows are hidden, not deleted: published user content and its
-- favorites stay recoverable, while every public read path already skips hidden rows.
UPDATE items SET hidden = 1 WHERE type = 'multi-scene';

CREATE TRIGGER reject_multi_scene_insert
BEFORE INSERT ON items
WHEN NEW.type = 'multi-scene'
BEGIN
  SELECT RAISE(ABORT, 'multi-scene retired');
END;

-- Only a change *into* the retired type is refused; maintenance of an archived row
-- (for example by account cleanup) must still succeed. Archived rows cannot be shown again.
CREATE TRIGGER reject_multi_scene_update
BEFORE UPDATE ON items
WHEN NEW.type = 'multi-scene' AND (OLD.type <> 'multi-scene' OR NEW.hidden = 0)
BEGIN
  SELECT RAISE(ABORT, 'multi-scene retired');
END;
