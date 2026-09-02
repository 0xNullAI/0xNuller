-- 浏览、下载与综合热度列表。下载代表更强的使用意图，因此在热度中权重为 4。
CREATE INDEX idx_items_visible_views
  ON items (views DESC, created_at DESC, id)
  WHERE hidden = 0;

CREATE INDEX idx_items_visible_hot
  ON items ((views + downloads * 4) DESC, created_at DESC, id)
  WHERE hidden = 0;
