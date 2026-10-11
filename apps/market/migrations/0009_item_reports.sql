-- Reports are private moderation records, never embedded in public cards or legacy reports counts.
CREATE TABLE item_reports (
 id TEXT PRIMARY KEY,
 item_id TEXT NOT NULL,
 item_name TEXT NOT NULL,
 reporter_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('unsafe','harassment','privacy','copyright','spam')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','hidden','dismissed','removed')),
 created_at INTEGER NOT NULL,
 resolved_at INTEGER,
 UNIQUE(item_id, reporter_id)
);
CREATE INDEX idx_item_reports_queue ON item_reports(status,created_at,id);
CREATE INDEX idx_item_reports_rate ON item_reports(reporter_id,created_at);
CREATE TRIGGER item_reports_on_hide AFTER UPDATE OF hidden ON items WHEN NEW.hidden=1
BEGIN
 UPDATE item_reports SET status='hidden',resolved_at=unixepoch()*1000 WHERE item_id=NEW.id AND status='pending';
END;
CREATE TRIGGER item_reports_on_delete AFTER DELETE ON items
BEGIN
 UPDATE item_reports SET status='removed',resolved_at=unixepoch()*1000 WHERE item_id=OLD.id AND status='pending';
END;
