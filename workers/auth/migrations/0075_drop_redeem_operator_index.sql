-- Redeem key minting has no per-admin daily cap, so nothing reads batches by operator and time.
DROP INDEX IF EXISTS idx_redeem_batches_operator;
