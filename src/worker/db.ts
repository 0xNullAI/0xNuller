import type { ItemType, MarketItem } from '../shared/schema';

// D1 行 → MarketItem。content/tags 反序列化。
interface ItemRow {
  id: string;
  type: string;
  name: string;
  description: string | null;
  author: string | null;
  icon: string | null;
  tags: string | null;
  content: string;
  downloads: number;
  created_at: number;
}

export function rowToItem(row: ItemRow): MarketItem {
  return {
    id: row.id,
    type: row.type as ItemType,
    name: row.name,
    description: row.description ?? undefined,
    author: row.author ?? undefined,
    icon: row.icon ?? undefined,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    content: JSON.parse(row.content),
    downloads: row.downloads,
    createdAt: row.created_at,
  };
}

export interface ListParams {
  type?: ItemType;
  q?: string;
  sort: 'new' | 'popular';
  limit: number;
  offset: number;
}

export async function listItems(db: D1Database, params: ListParams): Promise<MarketItem[]> {
  const where: string[] = ['hidden = 0'];
  const binds: unknown[] = [];

  if (params.type) {
    where.push('type = ?');
    binds.push(params.type);
  }
  if (params.q) {
    where.push('(name LIKE ? OR description LIKE ? OR tags LIKE ?)');
    const like = `%${params.q}%`;
    binds.push(like, like, like);
  }

  const order = params.sort === 'popular' ? 'downloads DESC, created_at DESC' : 'created_at DESC';
  const sql = `SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`;
  binds.push(params.limit, params.offset);

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<ItemRow>();
  return (results ?? []).map(rowToItem);
}

export async function getItem(db: D1Database, id: string): Promise<MarketItem | null> {
  const row = await db
    .prepare('SELECT * FROM items WHERE id = ? AND hidden = 0')
    .bind(id)
    .first<ItemRow>();
  return row ? rowToItem(row) : null;
}

export interface InsertItem {
  id: string;
  type: ItemType;
  name: string;
  description?: string;
  author?: string;
  icon?: string;
  tags?: string[];
  content: unknown;
  ipHash: string;
  createdAt: number;
}

export async function insertItem(db: D1Database, item: InsertItem): Promise<void> {
  await db
    .prepare(
      `INSERT INTO items (id, type, name, description, author, icon, tags, content, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      item.id,
      item.type,
      item.name,
      item.description ?? null,
      item.author ?? null,
      item.icon ?? null,
      item.tags && item.tags.length ? item.tags.join(',') : null,
      JSON.stringify(item.content),
      item.ipHash,
      item.createdAt,
    )
    .run();
}

export async function incrementDownloads(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE items SET downloads = downloads + 1 WHERE id = ?').bind(id).run();
}

export async function reportItem(db: D1Database, id: string): Promise<void> {
  // reports 达到阈值自动隐藏，等待管理员复核。
  await db
    .prepare('UPDATE items SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= 5 THEN 1 ELSE hidden END WHERE id = ?')
    .bind(id)
    .run();
}

export async function adminDelete(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
}

// 限流：统计同一来源近 windowMs 内的上传数。
export async function recentUploadCount(
  db: D1Database,
  ipHash: string,
  sinceMs: number,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM items WHERE ip_hash = ? AND created_at >= ?')
    .bind(ipHash, sinceMs)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
