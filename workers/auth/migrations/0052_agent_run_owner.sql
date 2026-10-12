-- A run is readable by its account on every device, but only the window that
-- created it may claim new tools or finish it. Existing active runs have no
-- owner capability and therefore fail closed until maintenance marks review.
ALTER TABLE agent_runs ADD COLUMN owner_hash TEXT;
