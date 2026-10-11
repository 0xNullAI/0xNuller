-- The realtime voice this account chose for one private AI identity. Empty
-- means "use the account's default voice". Voice IDs are provider-specific;
-- the client applies it only when the active provider offers that voice.
ALTER TABLE character_relationships ADD COLUMN voice TEXT NOT NULL DEFAULT '';
