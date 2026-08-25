import {
  ItemPatchSchema,
  BatchUploadSchema,
  ModerationPatchSchema,
  UploadSchema,
} from '../shared/schema';
import type { ItemPatchRow, InsertItem } from './db';
import {
  deleteItem,
  getItem,
  incrementDownloads,
  incrementViews,
  insertItem,
  insertItems,
  listAdminItems,
  listItems,
  recentUploadCount,
  setItemHidden,
  updateItemMeta,
} from './db';
import { hashSourceIp } from './security';

interface MarketAuthService extends Fetcher {
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
}

type Env = Omit<Cloudflare.Env, 'AUTH'> & {
  AUTH: MarketAuthService;
};

// Compatible clients on other origins can browse and import the public catalog.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) return err('接口不存在', 404);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      // GET /api/items —— list / search
      if (pathname === '/api/items' && request.method === 'GET') {
        const typeParam = url.searchParams.get('type');
        const type =
          typeParam === 'waveform' || typeParam === 'scenario' || typeParam === 'multi-scene'
            ? typeParam
            : undefined;
        const modalityParam = url.searchParams.get('modality');
        const modality =
          modalityParam === 'electrostimulation' || modalityParam === 'vibration'
            ? modalityParam
            : undefined;
        const q = url.searchParams.get('q')?.trim() || undefined;
        const sort = url.searchParams.get('sort') === 'popular' ? 'popular' : 'new';
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const items = await listItems(env.DB, { type, modality, q, sort, limit, offset });
        return json({ items });
      }

      if (pathname === '/api/items/admin' && request.method === 'GET') {
        await requireMarketAdmin(request, env);
        const requestedType = url.searchParams.get('type');
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

      // GET /api/items/:id —— detail
      const detailMatch = pathname.match(/^\/api\/items\/([\w-]+)$/);
      if (detailMatch && request.method === 'GET') {
        const item = await getItem(env.DB, detailMatch[1]!);
        if (!item) return err('未找到该条目', 404);
        return json({ item });
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
} satisfies ExportedHandler<Env>;

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
    icon: payload.type === 'scenario' || payload.type === 'multi-scene' ? payload.icon : undefined,
    tags: payload.tags,
    content: payload.content,
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

// Change metadata: empty string / empty array -> null (clears the field).
// Authentication is account ownership; account administrators can moderate old items.
async function handleEditPatch(request: Request, env: Env, id: string): Promise<Response> {
  if (!(await getItem(env.DB, id))) return err('未找到该条目', 404);
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

  const ok = await updateItemMeta(env.DB, id, row);
  if (!ok) return err('未找到该条目', 404);
  return json({ ok: true });
}
