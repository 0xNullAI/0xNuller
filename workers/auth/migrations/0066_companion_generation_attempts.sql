-- Provider errors for one scheduled occurrence are retried a few times; each attempt keeps
-- its own reservation key. The count lets the worker stop after a bounded number of tries.
ALTER TABLE companion_generations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
