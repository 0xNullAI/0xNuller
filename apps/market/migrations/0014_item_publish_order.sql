-- Monotonic insertion boundary for a stable public latest-published cursor.
-- AUTOINCREMENT prevents sequence reuse when the most recent item is deleted.
CREATE TABLE item_publish_order (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL UNIQUE
);
INSERT INTO item_publish_order(item_id) SELECT id FROM items ORDER BY rowid;
CREATE TRIGGER item_publish_order_insert AFTER INSERT ON items BEGIN
  INSERT INTO item_publish_order(item_id) VALUES (NEW.id);
END;
CREATE TRIGGER item_publish_order_delete AFTER DELETE ON items BEGIN
  DELETE FROM item_publish_order WHERE item_id = OLD.id;
END;
