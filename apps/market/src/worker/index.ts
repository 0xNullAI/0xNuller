import { handleReports } from './reports';
import { handleDiscovery } from './discovery';
import { handleDiscoveryFeedback } from './discovery-feedback';
import {
  handleCharacterConversion,
  purgeExpiredCharacterConversions,
  purgeInactiveDiscoveryOwners,
} from './character-conversion';
import {
  annotateScenarioContent,
  promptKind,
  ItemPatchSchema,
  BatchUploadSchema,
  ModerationPatchSchema,
  ScenarioContentSchema,
  UploadSchema,
} from '../shared/schema';
import type { ItemPatchRow, InsertItem, ListParams } from './db';
import {
  deleteItem,
  getArchivedCharacterVersion,
  getItem,
  incrementDownloads,
  incrementViews,
  insertItem,
  insertItems,
  latestItemPublishSeq,
  listAdminItems,
  listArchivedCharacterVersions,
  listItems,
  recentUploadCount,
  setItemHidden,
  updateItemMeta,
} from './db';
import { browseFilter, decodeBrowseCursor, encodeBrowseCursor } from './browse-cursor';
import { hashSourceIp } from './security';
import {
  cleanUnfinishedPortraits,
  handleCharacterPortraits,
  validatePortraitReference,
} from './character-portraits';
import {
  cleanUnfinishedCharacterContainers,
  handleCharacterContainerDrafts,
  purgeDeletedAccountContainers,
} from './character-container-drafts';
import { withServerErrorCounting, type ServerErrorReport } from '@0xnullai/observability';

interface MarketAuthService extends Fetcher {
  /** Fail-open error counter (see @0xnullai/observability). */
  recordServerErrors(report: ServerErrorReport): Promise<unknown>;
  claimMarketItems(
    credentials: { authorization: string | null; cookie: string | null },
    itemIds: string[],
    proof: 'market-upload',
  ): Promise<'ok' | 'unauthorized' | 'conflict'>;
  marketItemAccess(
    credentials: { authorization: string | null; cookie: string | null },
    itemId: string,
  ): Promise<'admin' | 'owner' | 'user' | 'unauthorized'>;
  marketAccountAccess(credentials: {
    authorization: string | null;
    cookie: string | null;
  }): Promise<'admin' | 'user' | 'unauthorized'>;
  marketAccountIdentity(credentials: {
    authorization: string | null;
    cookie: string | null;
  }): Promise<{ id: string } | null>;
  marketAccountActive(userId: string): Promise<boolean>;
  marketItemCreator(itemId: string): Promise<{
    id: string;
    username: string;
    displayName: string;
  } | null>;
  marketCreatorsForItems(itemIds: string[]): Promise<
    {
      itemId: string;
      creator: { id: string; username: string; displayName: string };
      workCount: number;
    }[]
  >;
  rewardMarketDownload(
    credentials: { authorization: string | null; cookie: string | null },
    itemId: string,
  ): Promise<string>;
  tipMarketItem(
    credentials: { authorization: string | null; cookie: string | null },
    itemId: string,
    amount: number,
  ): Promise<string>;
}

type Env = Omit<Cloudflare.Env, 'AUTH'> & {
  AUTH: MarketAuthService;
  PORTRAITS: R2Bucket;
};

// Compatible clients on other origins can browse and import the public catalog.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Account-Id',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

function privateJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie, Authorization',
      ...CORS,
    },
  });
}

class MarketRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const UPLOAD_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const UPLOAD_LIMIT = 50; // at most 50 items per source per hour (batches included, counted per item)

function requiredSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

const marketWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) return err('接口不存在', 404);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      const container = await handleCharacterContainerDrafts(request, env);
      if (container) return container;
      const reports = await handleReports(request, env);
      if (reports) return reports;
      const feedback = await handleDiscoveryFeedback(request, env);
      if (feedback) return feedback;
      const conversion = await handleCharacterConversion(request, env);
      if (conversion) return conversion;
      const portrait = await handleCharacterPortraits(request, env);
      if (portrait) return portrait;
      // GET /api/items —— list / search
      const discovery = await handleDiscovery(request, env);
      if (discovery) return discovery;

      if (pathname === '/api/items' && request.method === 'GET') {
        const typeParam = url.searchParams.get('type');
        const type = typeParam === 'waveform' || typeParam === 'scenario' ? typeParam : undefined;
        if (typeParam && !type) return err('内容类型不受支持', 400);
        const kindParam = url.searchParams.get('kind');
        const selectedKind =
          kindParam === 'character' || kindParam === 'scene' ? kindParam : undefined;
        if (kindParam && !selectedKind) return err('卡片类型无效', 400);
        const modalityParam = url.searchParams.get('modality');
        const modality =
          modalityParam === 'electrostimulation' || modalityParam === 'vibration'
            ? modalityParam
            : undefined;
        const q = url.searchParams.get('q')?.trim() || undefined;
        const requestedSort = url.searchParams.get('sort');
        const sort =
          requestedSort === 'trending' ||
          requestedSort === 'hot' ||
          requestedSort === 'views' ||
          requestedSort === 'downloads'
            ? requestedSort
            : requestedSort === 'popular'
              ? 'downloads'
              : 'new';
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const params: ListParams = {
          type,
          promptKind: selectedKind,
          modality,
          q,
          sort,
          limit,
          offset,
          character: url.searchParams.get('character') === '1',
        };
        const cursorMode = url.searchParams.get('pagination') === 'cursor';
        let nextCursor: string | null = null;
        let pagination: 'stable' | 'live' | undefined;
        let items;
        if (cursorMode) {
          const filter = browseFilter(params);
          const rawCursor = url.searchParams.get('cursor');
          const cursorSecret = requiredSecret(env.MARKET_IP_PEPPER, 'MARKET_IP_PEPPER');
          const cursor = rawCursor
            ? await decodeBrowseCursor(rawCursor, filter, cursorSecret)
            : null;
          if (rawCursor && !cursor) return err('浏览游标无效或筛选条件已改变', 400);
          pagination = sort === 'new' ? 'stable' : 'live';
          if (cursor && cursor.mode !== pagination) return err('浏览游标排序无效', 400);
          const maxPublishSeq =
            pagination === 'stable'
              ? cursor?.mode === 'stable'
                ? cursor.maxPublishSeq
                : await latestItemPublishSeq(env.DB)
              : undefined;
          const page = await listItems(env.DB, {
            ...params,
            limit: limit + 1,
            offset: pagination === 'live' && cursor?.mode === 'live' ? cursor.offset : 0,
            maxPublishSeq,
            after:
              cursor?.mode === 'stable'
                ? { createdAt: cursor.createdAt, id: cursor.id }
                : undefined,
          });
          items = page.slice(0, limit);
          if (page.length > limit && items.length) {
            const last = items[items.length - 1]!;
            nextCursor = await encodeBrowseCursor(
              pagination === 'stable'
                ? {
                    version: 1,
                    mode: 'stable',
                    filter,
                    maxPublishSeq: maxPublishSeq!,
                    createdAt: last.createdAt,
                    id: last.id,
                  }
                : {
                    version: 1,
                    mode: 'live',
                    filter,
                    offset: (cursor?.mode === 'live' ? cursor.offset : 0) + limit,
                  },
              cursorSecret,
            );
          }
        } else {
          items = await listItems(env.DB, params);
        }
        const claims =
          items.length && env.AUTH.marketCreatorsForItems
            ? await env.AUTH.marketCreatorsForItems(items.map((item) => item.id))
            : [];
        const creators = new Map(claims.map(({ itemId, creator }) => [itemId, creator]));
        return json({
          items: items.map((item) => ({
            ...item,
            ...(creators.has(item.id) ? { verifiedCreator: creators.get(item.id) } : {}),
          })),
          ...(cursorMode ? { nextCursor, pagination } : {}),
        });
      }

      if (pathname === '/api/items/admin' && request.method === 'GET') {
        await requireMarketAdmin(request, env);
        const requestedType = url.searchParams.get('type');
        if (requestedType && requestedType !== 'scenario' && requestedType !== 'waveform')
          return err('内容类型不受支持', 400);
        const type = requestedType === 'scenario' ? 'scenario' : 'waveform';
        const requestedStatus = url.searchParams.get('status');
        const status =
          requestedStatus === 'hidden' || requestedStatus === 'visible' ? requestedStatus : 'all';
        const q = url.searchParams.get('q')?.trim() || undefined;
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const items = await listAdminItems(env.DB, { type, status, q, limit, offset });
        return json({ items, nextOffset: items.length === limit ? offset + limit : null });
      }

      const moderationMatch = pathname.match(/^\/api\/items\/([\w-]+)\/moderation$/);
      if (moderationMatch && request.method === 'PATCH') {
        await requireMarketAdmin(request, env);
        const body = await request.json().catch(() => null);
        const parsed = ModerationPatchSchema.safeParse(body);
        if (!parsed.success) return err('数据校验失败', 400);
        const updated = await setItemHidden(env.DB, moderationMatch[1]!, parsed.data.hidden);
        if (!updated) return err('未找到该条目', 404);
        return json({ ok: true });
      }

      const revisionsMatch = pathname.match(/^\/api\/items\/([\w-]+)\/revisions(?:\/(\d+))?$/);
      if (revisionsMatch && request.method === 'GET') {
        const id = revisionsMatch[1]!;
        const item = await getItem(env.DB, id);
        if (!item || item.type !== 'scenario') return err('公开卡不存在或已下架', 404);
        const access = await marketAccess(request, env, id);
        if (access === 'unauthorized') return err('请先登录', 401);
        if (access !== 'owner' && access !== 'admin') return err('无权查看公开卡历史', 403);
        const currentRevision = item.revision ?? 1;
        if (!revisionsMatch[2]) {
          const archived = await listArchivedCharacterVersions(env.DB, id);
          return privateJson({
            versions: [
              { revision: currentRevision, name: item.name, archivedAt: null, current: true },
              ...archived,
            ],
          });
        }
        const requestedRevision = Number(revisionsMatch[2]);
        if (!Number.isSafeInteger(requestedRevision) || requestedRevision < 1)
          return err('版本编号无效', 400);
        const snapshot =
          requestedRevision === currentRevision
            ? {
                revision: currentRevision,
                name: item.name,
                description: item.description,
                icon: item.icon,
                tags: item.tags,
                content: item.content,
                archivedAt: null,
              }
            : await getArchivedCharacterVersion(env.DB, id, requestedRevision);
        return snapshot ? privateJson({ snapshot }) : err('版本不存在', 404);
      }

      // GET /api/items/:id —— detail
      const detailMatch = pathname.match(/^\/api\/items\/([\w-]+)$/);
      if (detailMatch && request.method === 'GET') {
        const item = await getItem(env.DB, detailMatch[1]!);
        if (!item) return err('未找到该条目', 404);
        const creator = env.AUTH.marketItemCreator
          ? await env.AUTH.marketItemCreator(item.id)
          : null;
        return json({ item: { ...item, ...(creator ? { verifiedCreator: creator } : {}) } });
      }

      // PATCH /api/items/:id —— account owner or account administrator edits metadata.
      if (detailMatch && request.method === 'PATCH') {
        return await handleEditPatch(request, env, detailMatch[1]!);
      }

      const accessMatch = pathname.match(/^\/api\/items\/([\w-]+)\/access$/);
      if (accessMatch && request.method === 'GET') {
        const access = await marketAccess(request, env, accessMatch[1]!);
        return json({
          canEdit: access === 'owner' || access === 'admin',
          canDelete: access === 'owner' || access === 'admin',
        });
      }

      if (detailMatch && request.method === 'DELETE') {
        const access = await marketAccess(request, env, detailMatch[1]!);
        if (access === 'unauthorized') return err('未登录', 401);
        if (access !== 'owner' && access !== 'admin') return err('无权限', 403);
        await deleteItem(env.DB, detailMatch[1]!);
        return json({ ok: true });
      }

      // POST /api/items —— upload
      if (pathname === '/api/items' && request.method === 'POST') {
        return await handleUpload(request, env);
      }

      // POST /api/items/batch —— batch upload (several items at once)
      if (pathname === '/api/items/batch' && request.method === 'POST') {
        return await handleBatchUpload(request, env);
      }

      // POST /api/items/:id/download —— download counter
      const dlMatch = pathname.match(/^\/api\/items\/([\w-]+)\/download$/);
      if (dlMatch && request.method === 'POST') {
        await incrementDownloads(env.DB, dlMatch[1]!);
        await env.AUTH.rewardMarketDownload(credentialsFrom(request), dlMatch[1]!);
        return json({ ok: true });
      }

      const tipMatch = pathname.match(/^\/api\/items\/([\w-]+)\/tip$/);
      if (tipMatch && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { amount?: number };
        const result = await env.AUTH.tipMarketItem(
          credentialsFrom(request),
          tipMatch[1]!,
          Number(body.amount),
        );
        if (result !== 'ok')
          return err(
            result === 'unauthorized' ? '请先登录' : '打赏失败',
            result === 'unauthorized' ? 401 : 400,
          );
        return json({ ok: true });
      }

      // POST /api/items/:id/view —— view counter
      const viewMatch = pathname.match(/^\/api\/items\/([\w-]+)\/view$/);
      if (viewMatch && request.method === 'POST') {
        await incrementViews(env.DB, viewMatch[1]!);
        return json({ ok: true });
      }

      return err('接口不存在', 404);
    } catch (error) {
      if (error instanceof MarketRequestError) return err(error.message, error.status);
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'market_request_failed',
          method: request.method,
          path: pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return err('服务器错误', 500);
    }
  },
  async scheduled(_event, env): Promise<void> {
    await cleanUnfinishedPortraits(env);
    await cleanUnfinishedCharacterContainers(env);
    await purgeDeletedAccountContainers(env);
    await purgeExpiredCharacterConversions(env.DB);
    await purgeInactiveDiscoveryOwners(env);
  },
} satisfies ExportedHandler<Env>;

export default withServerErrorCounting(marketWorker, {
  worker: 'market',
  sink: (env: Env) => env.AUTH,
});
type UploadOne = ReturnType<typeof UploadSchema.parse>;

// A validated single payload -> a database row. Ownership lives in Auth.
async function toInsert(
  payload: UploadOne,
  ipHash: string,
  createdAt: number,
): Promise<InsertItem> {
  return {
    id: crypto.randomUUID(),
    type: payload.type,
    name: payload.name,
    description: payload.description,
    author: payload.author,
    icon: payload.type === 'scenario' ? payload.icon : undefined,
    tags: payload.tags,
    content:
      payload.type === 'scenario'
        ? annotateScenarioContent({ ...payload.content, kind: promptKind(payload.content) })
        : payload.content,
    ipHash,
    createdAt,
  };
}

interface ClaimCredentials {
  authorization: string | null;
  cookie: string | null;
}

function credentialsFrom(request: Request): ClaimCredentials {
  return {
    authorization: request.headers.get('Authorization'),
    cookie: request.headers.get('Cookie'),
  };
}

function hasCredentials(credentials: ClaimCredentials): boolean {
  return !!credentials.authorization || !!credentials.cookie;
}

export async function recordVerifiedClaims(
  env: { AUTH: Pick<MarketAuthService, 'claimMarketItems'> },
  request: Request,
  itemIds: string[],
): Promise<'claimed'> {
  const credentials = credentialsFrom(request);
  if (!hasCredentials(credentials)) throw new MarketRequestError('请先登录', 401);
  const result = await env.AUTH.claimMarketItems(credentials, itemIds, 'market-upload');
  if (result === 'unauthorized') throw new MarketRequestError('登录已失效', 401);
  if (result === 'conflict') throw new MarketRequestError('条目归属冲突', 409);
  return 'claimed';
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err('请求体不是合法 JSON', 400);
  }

  const parsed = UploadSchema.safeParse(body);
  if (!parsed.success) {
    return err(`数据校验失败：${parsed.error.issues[0]?.message ?? '未知字段错误'}`, 400);
  }

  if (parsed.data.type === 'scenario' && parsed.data.content.portraitId) {
    const access = await validatePortraitReference(env, request, parsed.data.content.portraitId);
    if (access !== 'ok')
      return err(
        access === 'unauthorized' ? '请先登录' : '无权使用此头像',
        access === 'unauthorized' ? 401 : 403,
      );
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  const ipHash = await hashSourceIp(ip, requiredSecret(env.MARKET_IP_PEPPER, 'MARKET_IP_PEPPER'));

  const now = Date.now();
  const recent = await recentUploadCount(env.DB, ipHash, now - UPLOAD_WINDOW_MS);
  if (recent >= UPLOAD_LIMIT) {
    return err(`上传过于频繁，请稍后再试（每小时最多 ${UPLOAD_LIMIT} 条）`, 429);
  }

  const row = await toInsert(parsed.data, ipHash, now);
  await insertItem(env.DB, row);
  try {
    const ownership = await recordVerifiedClaims(env, request, [row.id]);
    return json({ ok: true, id: row.id, ownership }, 201);
  } catch (error) {
    // An authenticated upload must not succeed without its durable ownership record.
    // Delete the Market row so a retry is safe and does not strand an unclaimable item.
    await deleteItem(env.DB, row.id);
    throw error;
  }
}

async function handleBatchUpload(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err('请求体不是合法 JSON', 400);
  }

  const parsed = BatchUploadSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.[0] != null ? `第 ${Number(issue.path[0]) + 1} 条：` : '';
    return err(`数据校验失败：${where}${issue?.message ?? '未知字段错误'}`, 400);
  }
  const payloads = parsed.data;
  for (const payload of payloads) {
    if (payload.type !== 'scenario' || !payload.content.portraitId) continue;
    const access = await validatePortraitReference(env, request, payload.content.portraitId);
    if (access !== 'ok')
      return err(
        access === 'unauthorized' ? '请先登录' : '无权使用此头像',
        access === 'unauthorized' ? 401 : 403,
      );
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  const ipHash = await hashSourceIp(ip, requiredSecret(env.MARKET_IP_PEPPER, 'MARKET_IP_PEPPER'));

  const now = Date.now();
  const recent = await recentUploadCount(env.DB, ipHash, now - UPLOAD_WINDOW_MS);
  if (recent + payloads.length > UPLOAD_LIMIT) {
    return err(
      `本批 ${payloads.length} 条会超出每小时上限（${UPLOAD_LIMIT} 条，已用 ${recent}），请减少数量或稍后再试`,
      429,
    );
  }

  // The whole batch shares one timestamp baseline, staggered 1ms apart in order to preserve
  // the upload order.
  const rows = await Promise.all(payloads.map((p, i) => toInsert(p, ipHash, now + i)));
  await insertItems(env.DB, rows);
  try {
    const ownership = await recordVerifiedClaims(
      env,
      request,
      rows.map((r) => r.id),
    );
    return json({ ok: true, inserted: rows.length, ids: rows.map((r) => r.id), ownership }, 201);
  } catch (error) {
    await Promise.all(rows.map((row) => deleteItem(env.DB, row.id)));
    throw error;
  }
}

async function marketAccess(
  request: Request,
  env: { AUTH: Pick<MarketAuthService, 'marketItemAccess'> },
  id: string,
) {
  return env.AUTH.marketItemAccess(credentialsFrom(request), id);
}

export async function requireMarketAdmin(
  request: Request,
  env: { AUTH: Pick<MarketAuthService, 'marketAccountAccess'> },
): Promise<void> {
  const access = await env.AUTH.marketAccountAccess(credentialsFrom(request));
  if (access === 'unauthorized') throw new MarketRequestError('请先登录', 401);
  if (access !== 'admin') throw new MarketRequestError('需要管理员权限', 403);
}

// Change metadata or scene content: empty string / empty array -> null (clears metadata).
// Authentication is account ownership; account administrators can moderate old items.
async function handleEditPatch(request: Request, env: Env, id: string): Promise<Response> {
  const item = await getItem(env.DB, id);
  if (!item) return err('未找到该条目', 404);
  const access = await marketAccess(request, env, id);
  if (access === 'unauthorized') return err('未登录', 401);
  if (access !== 'owner' && access !== 'admin') return err('无权限', 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err('请求体不是合法 JSON', 400);
  }

  const parsed = ItemPatchSchema.safeParse(body);
  if (!parsed.success) {
    return err(`数据校验失败：${parsed.error.issues[0]?.message ?? '未知字段错误'}`, 400);
  }
  const p = parsed.data;

  const row: ItemPatchRow = {};
  if (p.name !== undefined) row.name = p.name;
  if (p.description !== undefined) row.description = p.description || null;
  if (p.author !== undefined) row.author = p.author || null;
  if (p.icon !== undefined) row.icon = p.icon || null;
  if (p.tags !== undefined) row.tags = p.tags.length ? p.tags.join(',') : null;
  if (p.content !== undefined) {
    if (item.type === 'scenario') {
      const content = ScenarioContentSchema.safeParse(p.content);
      if (!content.success) return err('剧本内容与条目类型不匹配', 400);
      // A published card keeps its role as a chat entity or a reusable scene.
      // Older clients omit `kind`, so infer the existing kind before merging.
      const oldContent = ScenarioContentSchema.safeParse(item.content);
      const kind = promptKind(item.content as typeof content.data);
      if (content.data.kind && content.data.kind !== kind)
        return err('已发布卡片的角色或场景类型不可修改，请创建新卡片', 409);
      if (kind === 'scene' && content.data.characterCard)
        return err('场景不能加入人物设定，请创建角色卡片', 400);
      const oldPortraitId = oldContent.success
        ? (oldContent.data.portraitId ?? undefined)
        : undefined;
      const portraitId =
        content.data.portraitId === null ? undefined : (content.data.portraitId ?? oldPortraitId);
      if (portraitId && portraitId !== oldPortraitId) {
        const portraitAccess = await validatePortraitReference(env, request, portraitId);
        if (portraitAccess !== 'ok')
          return err(
            portraitAccess === 'unauthorized' ? '请先登录' : '无权使用此头像',
            portraitAccess === 'unauthorized' ? 401 : 403,
          );
      }
      const next = ScenarioContentSchema.safeParse(
        annotateScenarioContent({
          ...content.data,
          kind,
          characterCard:
            kind === 'character'
              ? (content.data.characterCard ??
                (oldContent.success ? oldContent.data.characterCard : undefined))
              : undefined,
          sourceArchive:
            kind === 'scene' || content.data.sourceArchive === null
              ? undefined
              : (content.data.sourceArchive ??
                (oldContent.success ? (oldContent.data.sourceArchive ?? undefined) : undefined)),
          portraitId,
        }),
      );
      if (!next.success) return err('剧本内容与条目类型不匹配', 400);
      row.content = JSON.stringify(next.data);
    } else {
      return err('波形内容暂不支持在这里修改', 400);
    }
  }

  const ok = await updateItemMeta(env.DB, id, row, p.expectedRevision);
  if (!ok) return err('内容已由其他编辑更新，请重新载入', 409);
  return json({ ok: true });
}
