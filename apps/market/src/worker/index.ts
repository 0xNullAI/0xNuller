import { ItemPatchSchema, BatchUploadSchema, UploadSchema } from '../shared/schema';
import type { ItemPatchRow, InsertItem } from './db';
import {
  adminDelete,
  getEditKeyHash,
  getItem,
  incrementDownloads,
  incrementViews,
  insertItem,
  insertItems,
  listItems,
  recentUploadCount,
  reportItem,
  updateItemMeta,
  upgradeEditKeyHash,
} from './db';
import { hashCurrentEditKey, hashLegacyEditKey, hashSourceIp, secretEqual } from './security';

interface Env extends Cloudflare.Env {
  // Wrangler currently emits the named entrypoint as bare `Service`; keep the RPC
  // surface explicit here while still inheriting the generated binding.
  AUTH: Fetcher & {
    claimMarketItems(
      credentials: { authorization: string | null; cookie: string | null },
      itemIds: string[],
      proof: 'market-upload' | 'market-edit-key',
    ): Promise<'ok' | 'unauthorized' | 'conflict'>;
  };
  ADMIN_KEY: string;
  MARKET_LEGACY_EDIT_PEPPER: string;
  MARKET_EDIT_PEPPER: string;
  MARKET_IP_PEPPER: string;
}

// DG-Agent is deployed on GitHub Pages (a different origin), so CORS has to be open for it
// to fetch/import.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Admin-Key,X-Edit-Key',
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

    if (!pathname.startsWith('/api/')) {
      // Non-API requests go to Static Assets (the frontend SPA).
      return env.ASSETS.fetch(request);
    }

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
        const q = url.searchParams.get('q')?.trim() || undefined;
        const sort = url.searchParams.get('sort') === 'popular' ? 'popular' : 'new';
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const items = await listItems(env.DB, { type, q, sort, limit, offset });
        return json({ items });
      }

      // GET /api/items/:id —— detail
      const detailMatch = pathname.match(/^\/api\/items\/([\w-]+)$/);
      if (detailMatch && request.method === 'GET') {
        const item = await getItem(env.DB, detailMatch[1]!);
        if (!item) return err('未找到该条目', 404);
        return json({ item });
      }

      // PATCH /api/items/:id —— edit metadata
      // Items with no key set are publicly editable; items with a key require X-Edit-Key
      // (an admin's X-Admin-Key overrides it).
      if (detailMatch && request.method === 'PATCH') {
        return await handleEditPatch(request, env, detailMatch[1]!);
      }

      // A logged-in account may claim an existing locked item only after Market itself
      // verifies the plaintext edit key. Auth never trusts a caller-supplied hash.
      const claimMatch = pathname.match(/^\/api\/items\/([\w-]+)\/claim$/);
      if (claimMatch && request.method === 'POST') {
        return await handleClaim(request, env, claimMatch[1]!);
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

      // POST /api/items/:id/report —— report
      const reportMatch = pathname.match(/^\/api\/items\/([\w-]+)\/report$/);
      if (reportMatch && request.method === 'POST') {
        await reportItem(env.DB, reportMatch[1]!);
        return json({ ok: true });
      }

      // Admin delete /api/admin/items/:id (key in X-Admin-Key)
      const adminMatch = pathname.match(/^\/api\/admin\/items\/([\w-]+)$/);
      if (adminMatch && request.method === 'DELETE') {
        if (!(await isAdminRequest(request, env))) return err('无权限', 403);
        await adminDelete(env.DB, adminMatch[1]!);
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

// A validated single payload -> a database row (including the optional edit key hash).
async function toInsert(
  payload: UploadOne,
  ipHash: string,
  createdAt: number,
  env: Env,
): Promise<InsertItem> {
  const editKey = payload.editKey?.trim();
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
    editKeyHash: editKey
      ? await hashCurrentEditKey(
          editKey,
          requiredSecret(env.MARKET_EDIT_PEPPER, 'MARKET_EDIT_PEPPER'),
        )
      : undefined,
    editKeyScheme: 2,
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
  env: Env,
  request: Request,
  itemIds: string[],
): Promise<'claimed' | 'anonymous'> {
  const credentials = credentialsFrom(request);
  if (!hasCredentials(credentials)) return 'anonymous';
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

  const row = await toInsert(parsed.data, ipHash, now, env);
  await insertItem(env.DB, row);
  try {
    const ownership = await recordVerifiedClaims(env, request, [row.id]);
    return json({ ok: true, id: row.id, ownership }, 201);
  } catch (error) {
    // An authenticated upload must not succeed without its durable ownership record.
    // Delete the Market row so a retry is safe and does not strand an unclaimable item.
    await adminDelete(env.DB, row.id);
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
  const rows = await Promise.all(payloads.map((p, i) => toInsert(p, ipHash, now + i, env)));
  await insertItems(env.DB, rows);
  try {
    const ownership = await recordVerifiedClaims(
      env,
      request,
      rows.map((r) => r.id),
    );
    return json({ ok: true, inserted: rows.length, ids: rows.map((r) => r.id), ownership }, 201);
  } catch (error) {
    await Promise.all(rows.map((row) => adminDelete(env.DB, row.id)));
    throw error;
  }
}

async function isAdminRequest(request: Request, env: Env): Promise<boolean> {
  const provided = request.headers.get('X-Admin-Key') ?? '';
  return !!env.ADMIN_KEY && !!provided && secretEqual(provided, env.ADMIN_KEY);
}

/** Verify an item's key and opportunistically migrate a legacy ADMIN_KEY-derived hash. */
async function verifyItemEditKey(env: Env, id: string, provided: string): Promise<boolean> {
  const meta = await getEditKeyHash(env.DB, id);
  if (!meta?.hash || !provided) return false;
  const candidate =
    meta.scheme === 2
      ? await hashCurrentEditKey(
          provided,
          requiredSecret(env.MARKET_EDIT_PEPPER, 'MARKET_EDIT_PEPPER'),
        )
      : await hashLegacyEditKey(
          provided,
          requiredSecret(env.MARKET_LEGACY_EDIT_PEPPER, 'MARKET_LEGACY_EDIT_PEPPER'),
        );
  if (!(await secretEqual(candidate, meta.hash))) return false;
  if (meta.scheme === 1) {
    await upgradeEditKeyHash(
      env.DB,
      id,
      meta.hash,
      await hashCurrentEditKey(
        provided,
        requiredSecret(env.MARKET_EDIT_PEPPER, 'MARKET_EDIT_PEPPER'),
      ),
    );
  }
  return true;
}

async function handleClaim(request: Request, env: Env, id: string): Promise<Response> {
  const provided = request.headers.get('X-Edit-Key')?.trim() ?? '';
  if (!provided) return err('缺少编辑口令', 400);
  if (!(await verifyItemEditKey(env, id, provided))) return err('编辑口令错误', 403);
  const credentials = credentialsFrom(request);
  if (!hasCredentials(credentials)) return err('未登录', 401);
  const result = await env.AUTH.claimMarketItems(credentials, [id], 'market-edit-key');
  if (result === 'unauthorized') return err('未登录', 401);
  if (result === 'conflict') return err('该条目已由其他账号认领', 409);
  return json({ ok: true }, 200);
}

// Change metadata: empty string / empty array -> null (clears the field).
// Authentication: if the item has a key set, X-Edit-Key must match; an admin's
// X-Admin-Key can always edit.
async function handleEditPatch(request: Request, env: Env, id: string): Promise<Response> {
  const meta = await getEditKeyHash(env.DB, id);
  if (!meta) return err('未找到该条目', 404);

  const isAdmin = await isAdminRequest(request, env);
  if (!isAdmin && meta.hash) {
    const provided = request.headers.get('X-Edit-Key') ?? '';
    const ok = await verifyItemEditKey(env, id, provided);
    if (!ok) return err('编辑口令错误', 403);
  }

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
