import { getItem, listItems, rowToItem, visibleItemsByIds } from './db';
import {
  promptKind,
  type MarketItem,
  type PromptKind,
  type ScenarioContent,
} from '../shared/schema';

interface Creator {
  id: string;
  username: string;
  displayName: string;
}
interface CreatorAttribution {
  itemId: string;
  creator: Creator;
  workCount: number;
}
interface FeedbackPreference {
  target_kind: 'item' | 'creator';
  target_id: string;
  reason: 'not_interested' | 'too_similar' | 'hide_creator';
  tags?: string | null;
}
interface DiscoveryEnv {
  DB: D1Database;
  AUTH: {
    marketAccountIdentity: (credentials: {
      authorization: string | null;
      cookie: string | null;
    }) => Promise<{ id: string } | null>;
    marketItemCreator?: (id: string) => Promise<Creator | null>;
    marketCreatorItems?: (
      ids: string[],
      viewerId?: string,
    ) => Promise<{ itemId: string; creator: Creator }[]>;
    marketCreatorsForItems?: (ids: string[]) => Promise<CreatorAttribution[]>;
  };
}
const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Authorization, X-Account-Id',
  'Access-Control-Allow-Origin': '*',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

export function recommendItems(
  items: MarketItem[],
  favorites: MarketItem[],
  attributions: CreatorAttribution[] = [],
  preferences: FeedbackPreference[] = [],
  now = Date.now(),
): Array<MarketItem & { recommendationReason: string }> {
  const saved = new Set(favorites.map((item) => item.id));
  const tags = new Set(favorites.flatMap((item) => item.tags));
  const hiddenItems = new Set(
    preferences.filter((row) => row.target_kind === 'item').map((row) => row.target_id),
  );
  const hiddenCreators = new Set(
    preferences.filter((row) => row.target_kind === 'creator').map((row) => row.target_id),
  );
  const reducedTags = new Set(
    preferences
      .filter((row) => row.reason === 'too_similar')
      .flatMap((row) => row.tags?.split(',').filter(Boolean) ?? []),
  );
  const publishers = new Map(attributions.map((entry) => [entry.itemId, entry]));
  const ranked = items
    .filter((item) => !saved.has(item.id) && !hiddenItems.has(item.id))
    .map((item) => {
      const overlap = item.tags.filter((tag) => tags.has(tag)).slice(0, 3);
      const attribution = publishers.get(item.id);
      const newAuthor = Boolean(
        attribution && attribution.workCount <= 2 && item.createdAt >= now - 30 * 86_400_000,
      );
      const recent = item.createdAt >= now - 14 * 86_400_000;
      const reduced = item.tags.filter((tag) => reducedTags.has(tag)).length;
      return {
        item,
        overlap,
        attribution,
        newAuthor,
        recent,
        score:
          overlap.length * 15 +
          Math.min(10, Math.log2(item.downloads + 1) * 2) +
          (recent ? 3 : 0) +
          (newAuthor ? 6 : 0) -
          reduced * 8,
      };
    })
    .filter((entry) => !entry.attribution || !hiddenCreators.has(entry.attribution.creator.id))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.item.downloads - a.item.downloads ||
        b.item.createdAt - a.item.createdAt ||
        a.item.id.localeCompare(b.item.id),
    );
  const selected: typeof ranked = [];
  const counts = new Map<string, number>();
  const used = new Set<string>();
  const canTake = (entry: (typeof ranked)[number]) => {
    const id = entry.attribution?.creator.id;
    return !used.has(entry.item.id) && (!id || (counts.get(id) ?? 0) < 2);
  };
  while (selected.length < 30) {
    const reserved = selected.length % 5 === 2;
    const entry =
      (reserved
        ? ranked.find(
            (candidate) =>
              canTake(candidate) &&
              candidate.newAuthor &&
              candidate.attribution &&
              !counts.has(candidate.attribution.creator.id),
          )
        : undefined) ?? ranked.find(canTake);
    if (!entry) break;
    selected.push(entry);
    used.add(entry.item.id);
    if (entry.attribution) {
      const id = entry.attribution.creator.id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return selected.map(({ item, overlap, attribution, newAuthor, recent }) => ({
    ...item,
    ...(attribution ? { verifiedCreator: attribution.creator } : {}),
    recommendationReason: overlap.length
      ? `与你收藏的公开标签相同：${overlap.join('、')}${newAuthor ? '；新作者作品' : ''}`
      : newAuthor
        ? '新作者的近期角色'
        : recent
          ? '最近发布的公开角色'
          : '公开目录中的热门角色',
  }));
}
async function favoriteItems(db: D1Database, account: string): Promise<MarketItem[]> {
  const rows = await db
    .prepare(
      "SELECT i.* FROM item_favorites f JOIN items i ON i.id=f.item_id WHERE f.account_id=? AND i.hidden=0 AND i.type IN ('scenario','waveform') ORDER BY f.created_at DESC LIMIT 200",
    )
    .bind(account)
    .all<Parameters<typeof rowToItem>[0]>();
  return (rows.results ?? []).map((row) => rowToItem(row));
}
export async function handleDiscovery(
  request: Request,
  env: DiscoveryEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const favorite = /^\/api\/items\/([\w-]{1,128})\/favorite$/.exec(url.pathname);
  const follow = /^\/api\/items\/([\w-]{1,128})\/creator-follow$/.exec(url.pathname);
  const unfollow = /^\/api\/items\/creator-follows\/([\w-]{1,128})$/.exec(url.pathname);
  if (
    !favorite &&
    !follow &&
    !unfollow &&
    !['/api/items/discovery', '/api/items/creator-follows'].includes(url.pathname)
  )
    return null;
  const auth = await env.AUTH.marketAccountIdentity({
    authorization: request.headers.get('Authorization'),
    cookie: request.headers.get('Cookie'),
  });
  const account = auth?.id;
  if (!account) return json({ error: '请先登录' }, 401);
  const kindValue = url.searchParams.get('kind');
  if (kindValue && kindValue !== 'character' && kindValue !== 'scene')
    return json({ error: '卡片类型无效' }, 400);
  const selectedKind = kindValue as PromptKind | null;
  const selectedType = url.searchParams.get('type');
  if (selectedType && selectedType !== 'scenario' && selectedType !== 'waveform')
    return json({ error: '内容类型不受支持' }, 400);
  const matchesKind = (item: MarketItem): boolean =>
    (!selectedType || item.type === selectedType) &&
    (!selectedKind ||
      (item.type === 'scenario' && promptKind(item.content as ScenarioContent) === selectedKind));
  const expected = request.headers.get('X-Account-Id');
  if ((expected && expected !== account) || (request.method !== 'GET' && expected !== account))
    return json({ error: '账户已变化，请刷新后重试' }, 409);
  if (url.pathname === '/api/items/creator-follows') {
    if (request.method !== 'GET') return json({ error: '不支持的方法' }, 405);
    const rows = await env.DB.prepare(
      'SELECT creator_id AS id FROM creator_follows WHERE account_id=? ORDER BY created_at DESC LIMIT 200',
    )
      .bind(account)
      .all<{ id: string }>();
    const ids = (rows.results ?? []).map((row) => row.id);
    const claims = env.AUTH.marketCreatorItems
      ? await env.AUTH.marketCreatorItems(ids, account)
      : [];
    const profiles = new Map(claims.map((row) => [row.creator.id, row.creator]));
    return json({
      creators: ids.map((id) => ({ id, profile: profiles.get(id) ?? null })),
      accountId: account,
    });
  }
  if (unfollow) {
    if (request.method !== 'DELETE') return json({ error: '不支持的方法' }, 405);
    await env.DB.prepare('DELETE FROM creator_follows WHERE account_id=? AND creator_id=?')
      .bind(account, unfollow[1])
      .run();
    return json({ followed: false, accountId: account });
  }
  if (follow) {
    if (!env.AUTH.marketItemCreator) return json({ error: '作者身份服务暂不可用' }, 503);
    if (!(await getItem(env.DB, follow[1]!))) return json({ error: '内容不存在或已下架' }, 404);
    const creator = await env.AUTH.marketItemCreator(follow[1]!);
    if (!creator) return json({ creator: null, followed: false, accountId: account });
    if (request.method === 'PUT') {
      if (url.searchParams.get('creatorId') !== creator.id)
        return json({ error: '发布账户已变化，请刷新后重试' }, 409);
      if (creator.id === account) return json({ error: '无需关注自己' }, 400);
      await env.DB.prepare(
        `INSERT INTO creator_follows(account_id,creator_id,created_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM creator_follows WHERE account_id=?)<200 ON CONFLICT(account_id,creator_id) DO NOTHING`,
      )
        .bind(account, creator.id, Date.now(), account)
        .run();
    } else if (request.method !== 'GET') return json({ error: '不支持的方法' }, 405);
    const saved = await env.DB.prepare(
      'SELECT 1 FROM creator_follows WHERE account_id=? AND creator_id=?',
    )
      .bind(account, creator.id)
      .first();
    if (request.method === 'PUT' && !saved) return json({ error: '关注已达200人上限' }, 409);
    return json({ creator, followed: !!saved, accountId: account });
  }
  if (!favorite) {
    if (url.searchParams.get('mode') === 'creator') {
      if (request.method !== 'GET') return json({ error: '不支持的方法' }, 405);
      const creatorId = url.searchParams.get('creatorId');
      if (!creatorId || !/^[\w-]{1,128}$/.test(creatorId))
        return json({ error: '作者编号无效' }, 400);
      if (!env.AUTH.marketCreatorItems) return json({ error: '作者身份服务暂不可用' }, 503);
      const claims = await env.AUTH.marketCreatorItems([creatorId], account);
      const owned = claims.filter(({ creator }) => creator.id === creatorId);
      const items = await visibleItemsByIds(
        env.DB,
        owned.map(({ itemId }) => itemId),
      );
      const creators = new Map(owned.map(({ itemId, creator }) => [itemId, creator]));
      return json({
        items: items
          .filter(matchesKind)
          .map((item) => ({ ...item, verifiedCreator: creators.get(item.id) })),
        accountId: account,
      });
    }
    if (url.searchParams.get('mode') === 'following') {
      if (request.method !== 'GET') return json({ error: '不支持的方法' }, 405);
      if (!env.AUTH.marketCreatorItems) return json({ error: '作者身份服务暂不可用' }, 503);
      const follows = await env.DB.prepare(
        'SELECT creator_id FROM creator_follows WHERE account_id=? ORDER BY created_at DESC LIMIT 200',
      )
        .bind(account)
        .all<{ creator_id: string }>();
      const claims = await env.AUTH.marketCreatorItems(
        (follows.results ?? []).map((row) => row.creator_id),
        account,
      );
      // One bounded lookup for every claimed item instead of a query per item.
      const visible = new Map(
        (
          await visibleItemsByIds(
            env.DB,
            claims.map(({ itemId }) => itemId),
          )
        ).map((item) => [item.id, item]),
      );
      const items = claims.flatMap(({ itemId, creator }) => {
        const item = visible.get(itemId);
        return item
          ? [
              {
                ...item,
                verifiedCreator: creator,
                recommendationReason: `你关注的作者：${creator.displayName || creator.username}`,
              },
            ]
          : [];
      });
      return json({ items: items.filter(matchesKind), accountId: account });
    }
    if (request.method !== 'GET') return json({ error: '不支持的方法' }, 405);
    const favorites = await favoriteItems(env.DB, account);
    if (url.searchParams.get('mode') === 'favorites') {
      const visible = favorites.filter(matchesKind);
      const claims = env.AUTH.marketCreatorsForItems
        ? (
            await Promise.all(
              [visible.slice(0, 100), visible.slice(100, 200)]
                .filter((batch) => batch.length)
                .map((batch) => env.AUTH.marketCreatorsForItems!(batch.map((item) => item.id))),
            )
          ).flat()
        : [];
      const creators = new Map(claims.map(({ itemId, creator }) => [itemId, creator]));
      return json({
        items: visible.map((item) => ({
          ...item,
          ...(creators.has(item.id) ? { verifiedCreator: creators.get(item.id) } : {}),
        })),
        accountId: account,
      });
    }
    // Bounded candidate pool combines popularity with recent releases; no private chat data is read.
    const [popular, recent] = await Promise.all(
      ['downloads', 'new'].map((sort) =>
        listItems(env.DB, {
          type: 'scenario',
          sort: sort as 'downloads' | 'new',
          limit: 50,
          offset: 0,
        }),
      ),
    );
    const candidates = [
      ...new Map([...(popular ?? []), ...(recent ?? [])].map((item) => [item.id, item])).values(),
    ];
    const feedback = await env.DB.prepare(
      `SELECT f.target_kind,f.target_id,f.reason,i.tags
       FROM character_discovery_feedback f LEFT JOIN items i ON i.id=f.source_item_id
       WHERE f.account_id=? ORDER BY f.created_at DESC LIMIT 200`,
    )
      .bind(account)
      .all<FeedbackPreference>();
    const attributions = env.AUTH.marketCreatorsForItems
      ? await env.AUTH.marketCreatorsForItems(candidates.map((item) => item.id).slice(0, 100))
      : [];
    return json({
      items: recommendItems(
        candidates.filter(matchesKind),
        favorites,
        attributions,
        feedback.results ?? [],
      ),
      accountId: account,
    });
  }
  const id = favorite[1]!;
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM item_favorites WHERE account_id=? AND item_id=?')
      .bind(account, id)
      .run();
    return json({ favorited: false, accountId: account });
  }
  if (!(await getItem(env.DB, id))) return json({ error: '内容不存在或已下架' }, 404);
  if (request.method === 'GET') {
    const saved = await env.DB.prepare(
      'SELECT 1 AS saved FROM item_favorites WHERE account_id=? AND item_id=?',
    )
      .bind(account, id)
      .first();
    return json({ favorited: !!saved, accountId: account });
  }
  if (request.method !== 'PUT') return json({ error: '不支持的方法' }, 405);
  // Atomic visibility recheck and per-account bound. Idempotent set; refreshes do not reward credits.
  await env.DB.prepare(
    `INSERT INTO item_favorites(account_id,item_id,created_at) SELECT ?,id,? FROM items WHERE id=? AND hidden=0 AND (SELECT COUNT(*) FROM item_favorites f JOIN items i ON i.id=f.item_id WHERE f.account_id=? AND i.hidden=0) < 200 ON CONFLICT(account_id,item_id) DO NOTHING`,
  )
    .bind(account, Date.now(), id, account)
    .run();
  const saved = await env.DB.prepare(
    'SELECT 1 AS saved FROM item_favorites WHERE account_id=? AND item_id=?',
  )
    .bind(account, id)
    .first();
  return saved
    ? json({ favorited: true, accountId: account })
    : json({ error: '收藏已达200条上限，或内容已下架' }, 409);
}
