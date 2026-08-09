-- 无 type 过滤时的最新/热门列表。原复合索引以 type 开头，不能服务这两条查询。
CREATE INDEX idx_items_visible_new
  ON items (created_at DESC, id)
  WHERE hidden = 0;

CREATE INDEX idx_items_visible_popular
  ON items (downloads DESC, created_at DESC, id)
  WHERE hidden = 0;
