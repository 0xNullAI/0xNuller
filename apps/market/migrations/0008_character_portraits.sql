-- Immutable image objects belong to the author, while publication is controlled by
-- a visible character card referencing the id. Existing items need no rewrite.
CREATE TABLE character_portraits (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK(mime IN ('image/jpeg', 'image/png', 'image/webp')),
  status TEXT NOT NULL CHECK(status IN ('uploading', 'ready', 'deleting')),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_character_portraits_owner_created
  ON character_portraits(owner_id, created_at DESC);

CREATE INDEX idx_items_character_portrait
  ON items(CASE WHEN json_valid(content) THEN json_extract(content, '$.portraitId') END)
  WHERE type = 'scenario' AND hidden = 0;

-- Final D1 write rejects an image deleted after the Worker preflight check.
-- Triggers use iif rather than CASE ... END, which D1's remote statement splitter misreads.
CREATE TRIGGER validate_character_portrait_insert
BEFORE INSERT ON items
WHEN iif(json_valid(NEW.content), json_extract(NEW.content, '$.portraitId'), NULL) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid character portrait')
  WHERE NOT EXISTS (
    SELECT 1 FROM character_portraits
    WHERE id = json_extract(NEW.content, '$.portraitId') AND status = 'ready'
  );
END;

CREATE TRIGGER validate_character_portrait_update
BEFORE UPDATE OF content ON items
WHEN iif(json_valid(NEW.content), json_extract(NEW.content, '$.portraitId'), NULL) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid character portrait')
  WHERE NOT EXISTS (
    SELECT 1 FROM character_portraits
    WHERE id = json_extract(NEW.content, '$.portraitId') AND status = 'ready'
  );
END;
