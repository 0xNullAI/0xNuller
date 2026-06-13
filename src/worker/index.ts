import { AdminPatchSchema, UploadSchema } from '../shared/schema';
import type { AdminPatchRow } from './db';
import {
  adminDelete,
  adminUpdate,
  getItem,
  incrementDownloads,
  incrementViews,
  insertItem,
  listItems,
  recentUploadCount,
  reportItem,
} from './db';
import { verifyTurnstile } from './turnstile';

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
  ADMIN_KEY: string;
}

// DG-Agent 部署在 GitHub Pages（不同源），需要开放 CORS 供其拉取/导入。
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Key',
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

// 用 SHA-256 对来源 IP + 盐做哈希，避免明文存 IP。
async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${ip}:${salt}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const UPLOAD_WINDOW_MS = 60 * 60 * 1000; // 1 小时
const UPLOAD_LIMIT = 10; // 每来源每小时最多 10 条

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) {
      // 非 API 请求交给 Static Assets（前端 SPA）。
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      // GET /api/config —— 给前端的公开配置
      if (pathname === '/api/config' && request.method === 'GET') {
        return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY });
      }

      // GET /api/items —— 列表 / 搜索
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

      // GET /api/items/:id —— 详情
      const detailMatch = pathname.match(/^\/api\/items\/([\w-]+)$/);
      if (detailMatch && request.method === 'GET') {
        const item = await getItem(env.DB, detailMatch[1]!);
        if (!item) return err('未找到该条目', 404);
        return json({ item });
      }

      // POST /api/items —— 上传
      if (pathname === '/api/items' && request.method === 'POST') {
        return await handleUpload(request, env);
      }

      // POST /api/items/:id/download —— 下载计数
      const dlMatch = pathname.match(/^\/api\/items\/([\w-]+)\/download$/);
      if (dlMatch && request.method === 'POST') {
        await incrementDownloads(env.DB, dlMatch[1]!);
        return json({ ok: true });
      }

      // POST /api/items/:id/view —— 浏览计数
      const viewMatch = pathname.match(/^\/api\/items\/([\w-]+)\/view$/);
      if (viewMatch && request.method === 'POST') {
        await incrementViews(env.DB, viewMatch[1]!);
        return json({ ok: true });
      }

      // POST /api/items/:id/report —— 举报
      const reportMatch = pathname.match(/^\/api\/items\/([\w-]+)\/report$/);
      if (reportMatch && request.method === 'POST') {
        await reportItem(env.DB, reportMatch[1]!);
        return json({ ok: true });
      }

      // 管理员改 / 删 /api/admin/items/:id（口令 X-Admin-Key）
      const adminMatch = pathname.match(/^\/api\/admin\/items\/([\w-]+)$/);
      if (adminMatch && (request.method === 'DELETE' || request.method === 'PATCH')) {
        if (request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) return err('无权限', 403);
        if (request.method === 'DELETE') {
          await adminDelete(env.DB, adminMatch[1]!);
          return json({ ok: true });
        }
        return await handleAdminPatch(request, env, adminMatch[1]!);
      }

      return err('接口不存在', 404);
    } catch (e) {
      return err(`服务器错误：${(e as Error).message}`, 500);
    }
  },
} satisfies ExportedHandler<Env>;

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
  const payload = parsed.data;

  const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  const ipHash = await hashIp(ip, env.ADMIN_KEY || 'dg-market');

  const now = Date.now();
  const recent = await recentUploadCount(env.DB, ipHash, now - UPLOAD_WINDOW_MS);
  if (recent >= UPLOAD_LIMIT) {
    return err('上传过于频繁，请稍后再试（每小时最多 10 条）', 429);
  }

  const ok = await verifyTurnstile(payload.turnstileToken, env.TURNSTILE_SECRET, ip);
  if (!ok) return err('人机验证未通过', 403);

  const id = crypto.randomUUID();
  await insertItem(env.DB, {
    id,
    type: payload.type,
    name: payload.name,
    description: payload.description,
    author: payload.author,
    icon: payload.type === 'scenario' || payload.type === 'multi-scene' ? payload.icon : undefined,
    tags: payload.tags,
    content: payload.content,
    ipHash,
    createdAt: now,
  });

  return json({ ok: true, id }, 201);
}

// 管理员改元数据：空串/空数组 → null（清空字段）。
async function handleAdminPatch(request: Request, env: Env, id: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err('请求体不是合法 JSON', 400);
  }

  const parsed = AdminPatchSchema.safeParse(body);
  if (!parsed.success) {
    return err(`数据校验失败：${parsed.error.issues[0]?.message ?? '未知字段错误'}`, 400);
  }
  const p = parsed.data;

  const row: AdminPatchRow = {};
  if (p.name !== undefined) row.name = p.name;
  if (p.description !== undefined) row.description = p.description || null;
  if (p.author !== undefined) row.author = p.author || null;
  if (p.icon !== undefined) row.icon = p.icon || null;
  if (p.tags !== undefined) row.tags = p.tags.length ? p.tags.join(',') : null;

  const ok = await adminUpdate(env.DB, id, row);
  if (!ok) return err('未找到该条目', 404);
  return json({ ok: true });
}
