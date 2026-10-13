-- 综合 (trending) ranking counts favorites per candidate item. The table is keyed by
-- (account_id, item_id), so without this index every count scanned all favorites. Additive only.
CREATE INDEX IF NOT EXISTS idx_item_favorites_item ON item_favorites(item_id);
