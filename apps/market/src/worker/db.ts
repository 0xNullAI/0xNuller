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
  views: number;
  created_at: number;
  edit_key_hash: string | null;
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
    // 不外泄哈希本身，仅告诉前端这条是否被口令保护。
    locked: !!row.edit_key_hash,
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
  // 上传时设的编辑口令哈希；未设则 undefined（条目公开可编辑）。
  editKeyHash?: string;
}

const INSERT_SQL = `INSERT INTO items (id, type, name, description, author, icon, tags, content, ip_hash, created_at, edit_key_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
    item.editKeyHash ?? null,
  ];
}

export async function insertItem(db: D1Database, item: InsertItem): Promise<void> {
  await db.prepare(INSERT_SQL).bind(...insertBinds(item)).run();
}

// 批量插入：一次 D1 batch，原子提交（全部成功或全部回滚）。
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
  // reports 达到阈值自动隐藏，等待管理员复核。
  await db
    .prepare('UPDATE items SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= 5 THEN 1 ELSE hidden END WHERE id = ?')
    .bind(id)
    .run();
}

export async function adminDelete(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
}

// 取条目的编辑口令哈希用于鉴权：返回 null 表示条目不存在；
// { hash: null } 表示存在但未设口令（公开可编辑）。
export async function getEditKeyHash(
  db: D1Database,
  id: string,
): Promise<{ hash: string | null } | null> {
  const row = await db
    .prepare('SELECT edit_key_hash FROM items WHERE id = ? AND hidden = 0')
    .bind(id)
    .first<{ edit_key_hash: string | null }>();
  return row ? { hash: row.edit_key_hash } : null;
}

// 改条目元数据：列名取自固定白名单，值已规整（空 → null）。
export interface ItemPatchRow {
  name?: string;
  description?: string | null;
  author?: string | null;
  icon?: string | null;
  tags?: string | null;
}

export async function updateItemMeta(db: D1Database, id: string, patch: ItemPatchRow): Promise<boolean> {
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
