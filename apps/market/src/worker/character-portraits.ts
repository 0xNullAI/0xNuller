import { sanitizePhoto } from '@0xnullai/auth/photo-sanitizer';

const MAX_PORTRAIT_BYTES = 4_000_000;
const MAX_PORTRAITS_PER_OWNER = 500;
const MAX_PORTRAITS_PER_DAY = 30;
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface PortraitEnv {
  DB: D1Database;
  PORTRAITS: R2Bucket;
  AUTH: {
    marketAccountIdentity(credentials: {
      authorization: string | null;
      cookie: string | null;
    }): Promise<{ id: string } | null>;
  };
}

interface PortraitRow {
  id: string;
  owner_id: string;
  object_key: string;
  mime: string;
  status: string;
}

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

function error(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function accountId(request: Request, env: Pick<PortraitEnv, 'AUTH'>): Promise<string | null> {
  const identity = await env.AUTH.marketAccountIdentity({
    authorization: request.headers.get('Authorization'),
    cookie: request.headers.get('Cookie'),
  });
  return identity?.id ?? null;
}

async function readBounded(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new Error('图片为空');
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_PORTRAIT_BYTES) throw new Error('图片不能超过 4 MB');
      parts.push(result.value);
    }
  } catch (reason) {
    await reader.cancel().catch(() => undefined);
    throw reason;
  }
  if (!total) throw new Error('图片为空');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

export async function validatePortraitReference(
  env: Pick<PortraitEnv, 'DB' | 'AUTH'>,
  request: Request,
  portraitId: string,
): Promise<'ok' | 'unauthorized' | 'forbidden'> {
  const owner = await accountId(request, env);
  if (!owner) return 'unauthorized';
  const row = await env.DB.prepare(
    "SELECT owner_id FROM character_portraits WHERE id=? AND status='ready'",
  )
    .bind(portraitId)
    .first<{ owner_id: string }>();
  return row?.owner_id === owner ? 'ok' : 'forbidden';
}

export async function handleCharacterPortraits(
  request: Request,
  env: PortraitEnv,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/items/character-portraits' && request.method === 'POST') {
    const owner = await accountId(request, env);
    if (!owner) return error('请先登录', 401);
    const mime = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!MIME_TYPES.has(mime)) return error('仅支持 JPEG、PNG 或 WebP 图片', 415);
    const declaredLength = Number(request.headers.get('Content-Length'));
    if (declaredLength > MAX_PORTRAIT_BYTES) return error('图片不能超过 4 MB', 413);
    let image: Uint8Array;
    try {
      const raw = await readBounded(request);
      image = sanitizePhoto(raw.buffer as ArrayBuffer, mime);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '图片无效';
      return error(message, message === '图片不能超过 4 MB' ? 413 : 400);
    }
    const id = crypto.randomUUID();
    const objectKey = `characters/${owner}/${id}`;
    const now = Date.now();
    const reservation = await env.DB.prepare(
      `INSERT INTO character_portraits(id,owner_id,object_key,mime,status,created_at)
       SELECT ?,?,?,?,'uploading',?
       WHERE (SELECT COUNT(*) FROM character_portraits WHERE owner_id=?)<?
         AND (SELECT COUNT(*) FROM character_portraits WHERE owner_id=? AND created_at>=?)<?`,
    )
      .bind(
        id,
        owner,
        objectKey,
        mime,
        now,
        owner,
        MAX_PORTRAITS_PER_OWNER,
        owner,
        now - 86_400_000,
        MAX_PORTRAITS_PER_DAY,
      )
      .run();
    if (!reservation.meta.changes) return error('公开头像上传次数已达限制，请稍后再试', 429);
    try {
      await env.PORTRAITS.put(objectKey, image, { httpMetadata: { contentType: mime } });
      const result = await env.DB.prepare(
        "UPDATE character_portraits SET status='ready' WHERE id=? AND status='uploading'",
      )
        .bind(id)
        .run();
      if (!result.meta.changes) throw new Error('头像上传记录已失效');
    } catch (reason) {
      try {
        await env.PORTRAITS.delete(objectKey);
        await env.DB.prepare("DELETE FROM character_portraits WHERE id=? AND status='uploading'")
          .bind(id)
          .run();
      } catch (cleanupError) {
        console.error('market_portrait_cleanup_failed', id, cleanupError);
      }
      throw reason;
    }
    return new Response(JSON.stringify({ id }), {
      status: 201,
      headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const deleteMatch = pathname.match(/^\/api\/items\/character-portraits\/([0-9a-f-]{36})$/i);
  if (deleteMatch && request.method === 'DELETE') {
    const owner = await accountId(request, env);
    if (!owner) return error('请先登录', 401);
    const row = await env.DB.prepare(
      'SELECT owner_id,object_key,status FROM character_portraits WHERE id=?',
    )
      .bind(deleteMatch[1])
      .first<Pick<PortraitRow, 'owner_id' | 'object_key' | 'status'>>();
    if (!row || row.owner_id !== owner) return error('头像不存在', 404);
    if (row.status === 'deleting') return new Response(null, { status: 204, headers: HEADERS });
    if (row.status !== 'ready') return error('头像仍在上传，请稍后再试', 409);
    const reservation = await env.DB.prepare(
      `UPDATE character_portraits SET status='deleting'
       WHERE id=? AND owner_id=? AND status='ready'
         AND NOT EXISTS (
           SELECT 1 FROM items WHERE type='scenario'
             AND CASE WHEN json_valid(content) THEN json_extract(content,'$.portraitId') END=?
         )
         AND NOT EXISTS (
           SELECT 1 FROM character_item_versions
           WHERE CASE WHEN json_valid(content) THEN json_extract(content,'$.portraitId') END=?
         )`,
    )
      .bind(deleteMatch[1], owner, deleteMatch[1], deleteMatch[1])
      .run();
    if (!reservation.meta.changes) return error('头像已被角色版本引用，无法删除', 409);
    try {
      await env.PORTRAITS.delete(row.object_key);
      await env.DB.prepare("DELETE FROM character_portraits WHERE id=? AND status='deleting'")
        .bind(deleteMatch[1])
        .run();
    } catch (reason) {
      console.error('market_portrait_delete_retry_needed', deleteMatch[1], reason);
      return error('头像删除处理中，请稍后查看', 503);
    }
    return new Response(null, { status: 204, headers: HEADERS });
  }

  const match = pathname.match(/^\/api\/items\/character-portraits\/([0-9a-f-]{36})\/content$/i);
  if (!match || request.method !== 'GET') return null;
  const row = await env.DB.prepare(
    "SELECT id,owner_id,object_key,mime,status FROM character_portraits WHERE id=? AND status='ready'",
  )
    .bind(match[1])
    .first<PortraitRow>();
  if (!row) return error('头像不存在', 404);
  const published = await env.DB.prepare(
    `SELECT 1 AS visible FROM items
     WHERE type='scenario' AND hidden=0
       AND CASE WHEN json_valid(content) THEN json_extract(content,'$.portraitId') END=?
     LIMIT 1`,
  )
    .bind(row.id)
    .first<{ visible: number }>();
  if (!published) {
    const viewer = await accountId(request, env);
    if (viewer !== row.owner_id) return error('头像不存在', 404);
  }
  const object = await env.PORTRAITS.get(row.object_key);
  if (!object) return error('头像暂不可用', 503);
  return new Response(object.body, {
    headers: {
      ...HEADERS,
      'Content-Type': row.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

export async function cleanUnfinishedPortraits(
  env: Pick<PortraitEnv, 'DB' | 'PORTRAITS'>,
  now = Date.now(),
): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id,object_key FROM character_portraits WHERE status='deleting' OR (status='uploading' AND created_at<?) LIMIT 100",
  )
    .bind(now - 86_400_000)
    .all<Pick<PortraitRow, 'id' | 'object_key'>>();
  for (const row of rows.results ?? []) {
    try {
      await env.PORTRAITS.delete(row.object_key);
      await env.DB.prepare(
        "DELETE FROM character_portraits WHERE id=? AND status IN ('uploading','deleting')",
      )
        .bind(row.id)
        .run();
    } catch (reason) {
      console.error('market_portrait_cleanup_retry_needed', row.id, reason);
    }
  }
}
