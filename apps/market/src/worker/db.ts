import type { ItemType, MarketItem } from '../shared/schema';

// D1 row -> MarketItem. content/tags are deserialized.
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
  views: number;
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
    views: row.views,
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

// Legacy edit-key columns stay in D1 so existing rows migrate without a rewrite, but new
// account-owned rows never read or write them.
const INSERT_SQL = `INSERT INTO items (id, type, name, description, author, icon, tags, content, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertBinds(item: InsertItem): unknown[] {
  return [
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
  ];
}

export async function insertItem(db: D1Database, item: InsertItem): Promise<void> {
  await db
    .prepare(INSERT_SQL)
    .bind(...insertBinds(item))
    .run();
}

// Batch insert: a single D1 batch, committed atomically (all succeed or all roll back).
export async function insertItems(db: D1Database, items: InsertItem[]): Promise<void> {
  if (items.length === 0) return;
  const stmt = db.prepare(INSERT_SQL);
  await db.batch(items.map((item) => stmt.bind(...insertBinds(item))));
}

export async function incrementDownloads(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE items SET downloads = downloads + 1 WHERE id = ?').bind(id).run();
}

export async function incrementViews(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE items SET views = views + 1 WHERE id = ?').bind(id).run();
}

export async function reportItem(db: D1Database, id: string): Promise<void> {
  // Once reports reaches the threshold the item is hidden automatically, pending admin review.
  await db
    .prepare(
      'UPDATE items SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= 5 THEN 1 ELSE hidden END WHERE id = ?',
    )
    .bind(id)
    .run();
}

export async function deleteItem(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
}

// Change item metadata: column names come from a fixed allowlist, values are already
// normalized (empty -> null).
export interface ItemPatchRow {
  name?: string;
  description?: string | null;
  author?: string | null;
  icon?: string | null;
  tags?: string | null;
}

export async function updateItemMeta(
  db: D1Database,
  id: string,
  patch: ItemPatchRow,
): Promise<boolean> {
  const cols: (keyof ItemPatchRow)[] = ['name', 'description', 'author', 'icon', 'tags'];
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const col of cols) {
    if (patch[col] === undefined) continue;
    sets.push(`${col} = ?`);
    binds.push(patch[col]);
  }
  if (sets.length === 0) return false;
  binds.push(id);
  const res = await db
    .prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// Rate limiting: count how many uploads the same source made within the last windowMs.
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
