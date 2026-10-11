/** Trusted service-to-service attribution. Never use a card's editable author field as identity. */
export interface PublicMarketCreator {
  id: string;
  username: string;
  displayName: string;
}
export async function publicMarketCreator(
  db: D1Database,
  itemId: string,
): Promise<PublicMarketCreator | null> {
  if (typeof itemId !== 'string' || !/^[\w-]{1,128}$/.test(itemId)) return null;
  return db
    .prepare(
      `SELECT u.id,u.username,u.display_name AS displayName FROM market_claims m JOIN users u ON u.id=m.user_id WHERE m.item_id=? AND m.verified_at IS NOT NULL AND u.banned_at IS NULL AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=u.id) LIMIT 1`,
    )
    .bind(itemId)
    .first<PublicMarketCreator>();
}
/** Market must independently filter hidden/deleted items before displaying the bounded result. */
export async function publicMarketCreatorItems(
  db: D1Database,
  creatorIds: string[],
  viewerId?: string,
): Promise<{ itemId: string; creator: PublicMarketCreator }[]> {
  if (
    !Array.isArray(creatorIds) ||
    creatorIds.length > 200 ||
    creatorIds.some((id) => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) ||
    (viewerId !== undefined && !/^[\w-]{1,128}$/.test(viewerId))
  )
    return [];
  const ids = [...new Set(creatorIds)];
  if (!ids.length) return [];
  const result = await db
    .prepare(
      `SELECT m.item_id AS itemId,u.id,u.username,u.display_name AS displayName FROM market_claims m JOIN users u ON u.id=m.user_id WHERE u.id IN (${ids.map(() => '?').join(',')}) AND m.verified_at IS NOT NULL AND u.banned_at IS NULL AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=u.id) AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=? AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=?))) ORDER BY m.claimed_at DESC,m.item_id LIMIT 200`,
    )
    .bind(...ids, viewerId ?? null, viewerId ?? null, viewerId ?? null)
    .all<PublicMarketCreator & { itemId: string }>();
  return (result.results ?? []).map(({ itemId, ...creator }) => ({ itemId, creator }));
}

/** Bounded reverse lookup for discovery diversity; only verified, active public publishers. */
export async function publicMarketCreatorsForItems(
  db: D1Database,
  itemIds: string[],
): Promise<{ itemId: string; creator: PublicMarketCreator; workCount: number }[]> {
  if (
    !Array.isArray(itemIds) ||
    itemIds.length > 100 ||
    itemIds.some((id) => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id))
  )
    return [];
  const ids = [...new Set(itemIds)];
  if (!ids.length) return [];
  const rows = await db
    .prepare(
      `SELECT m.item_id AS itemId,u.id,u.username,u.display_name AS displayName,
       (SELECT COUNT(*) FROM market_claims works WHERE works.user_id=u.id AND works.verified_at IS NOT NULL) AS workCount
       FROM market_claims m JOIN users u ON u.id=m.user_id
       WHERE m.item_id IN (${ids.map(() => '?').join(',')}) AND m.verified_at IS NOT NULL
       AND u.banned_at IS NULL AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=u.id)
       ORDER BY m.item_id LIMIT 100`,
    )
    .bind(...ids)
    .all<PublicMarketCreator & { itemId: string; workCount: number }>();
  return (rows.results ?? []).map(({ itemId, workCount, ...creator }) => ({
    itemId,
    creator,
    workCount,
  }));
}
