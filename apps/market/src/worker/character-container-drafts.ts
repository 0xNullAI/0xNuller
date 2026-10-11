/** Private imported PNG/APNG and CHARX originals. Public item payloads never carry these ids. */
import { validateCharacterContainerBytes } from '../shared/external-card-container';
const MAX_BYTES = 20_000_000;
const MAX_OWNER_BYTES = 100_000_000;
const MAX_OWNER_FILES = 20;
const MAX_DAILY_UPLOADS = 20;

interface ContainerEnv {
  DB: D1Database;
  PORTRAITS: R2Bucket;
  AUTH: {
    marketAccountIdentity(credentials: {
      authorization: string | null;
      cookie: string | null;
    }): Promise<{ id: string } | null>;
    marketAccountActive(userId: string): Promise<boolean>;
  };
}

interface ContainerRow {
  id: string;
  owner_id: string;
  object_key: string;
  mime: string;
  byte_size: number;
  status: string;
}

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Authorization, X-Account-Id',
  'X-Content-Type-Options': 'nosniff',
};

function error(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function ownerId(request: Request, env: ContainerEnv): Promise<string | null> {
  const account = request.headers.get('X-Account-Id');
  if (!account) return null;
  const identity = await env.AUTH.marketAccountIdentity({
    authorization: request.headers.get('Authorization'),
    cookie: request.headers.get('Cookie'),
  });
  return identity?.id === account ? account : null;
}

async function readBounded(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new Error('原文件为空');
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) throw new Error('原文件不能超过 20 MB');
      parts.push(part.value);
    }
  } catch (reason) {
    await reader.cancel().catch(() => undefined);
    throw reason;
  }
  if (!length) throw new Error('原文件为空');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export async function handleCharacterContainerDrafts(
  request: Request,
  env: ContainerEnv,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/items/character-container-drafts' && request.method === 'GET') {
    const owner = await ownerId(request, env);
    if (!owner) return error('请先登录并确认当前账户', 401);
    const rows = await env.DB.prepare(
      "SELECT id,mime,byte_size,created_at FROM character_container_drafts WHERE owner_id=? AND status='ready' ORDER BY created_at DESC,id DESC LIMIT 20",
    )
      .bind(owner)
      .all<{ id: string; mime: string; byte_size: number; created_at: number }>();
    return new Response(
      JSON.stringify({
        items: (rows.results ?? []).map((row) => ({
          id: row.id,
          type: row.mime === 'image/png' ? 'png' : 'charx',
          bytes: row.byte_size,
          createdAt: row.created_at,
        })),
      }),
      { headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }
  if (pathname === '/api/items/character-container-drafts' && request.method === 'POST') {
    const owner = await ownerId(request, env);
    if (!owner) return error('请先登录并确认当前账户', 401);
    const mime = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
    if (mime !== 'image/png' && mime !== 'application/zip')
      return error('仅支持 PNG/APNG 或 CHARX 原文件', 415);
    if (Number(request.headers.get('Content-Length')) > MAX_BYTES)
      return error('原文件不能超过 20 MB', 413);
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(request);
    } catch (reason) {
      return error(reason instanceof Error ? reason.message : '原文件无效', 413);
    }
    try {
      validateCharacterContainerBytes(bytes, mime);
    } catch (reason) {
      return error(reason instanceof Error ? reason.message : '角色原文件无效', 400);
    }
    const id = crypto.randomUUID();
    const objectKey = `character-container-drafts/${owner}/${id}`;
    const now = Date.now();
    const reservation = await env.DB.prepare(
      `INSERT INTO character_container_drafts(id,owner_id,object_key,mime,byte_size,status,created_at)
       SELECT ?,?,?,?,?,'uploading',?
       WHERE (SELECT COUNT(*) FROM character_container_drafts WHERE owner_id=?)<?
         AND (SELECT COALESCE(SUM(byte_size),0) FROM character_container_drafts WHERE owner_id=?)+?<=?
         AND (SELECT COUNT(*) FROM character_container_upload_events WHERE owner_id=? AND created_at>=?)<?`,
    )
      .bind(
        id,
        owner,
        objectKey,
        mime,
        bytes.length,
        now,
        owner,
        MAX_OWNER_FILES,
        owner,
        bytes.length,
        MAX_OWNER_BYTES,
        owner,
        now - 86_400_000,
        MAX_DAILY_UPLOADS,
      )
      .run();
    if (!reservation.meta.changes) return error('私有原文件数量或容量已达上限；请删除旧文件', 429);
    try {
      await env.PORTRAITS.put(objectKey, bytes, { httpMetadata: { contentType: mime } });
      const result = await env.DB.prepare(
        "UPDATE character_container_drafts SET status='ready' WHERE id=? AND status='uploading'",
      )
        .bind(id)
        .run();
      if (!result.meta.changes) throw new Error('原文件上传记录已失效');
    } catch (reason) {
      try {
        await env.PORTRAITS.delete(objectKey);
        await env.DB.prepare(
          "DELETE FROM character_container_drafts WHERE id=? AND status='uploading'",
        )
          .bind(id)
          .run();
      } catch (cleanupError) {
        console.error('market_container_cleanup_failed', id, cleanupError);
      }
      throw reason;
    }
    return new Response(JSON.stringify({ id }), {
      status: 201,
      headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const match = pathname.match(
    /^\/api\/items\/character-container-drafts\/([0-9a-f-]{36})(?:\/content)?$/i,
  );
  if (!match || !['GET', 'HEAD', 'DELETE'].includes(request.method)) return null;
  const owner = await ownerId(request, env);
  if (!owner) return error('请先登录并确认当前账户', 401);
  const id = match[1]!;
  const row = await env.DB.prepare(
    'SELECT id,owner_id,object_key,mime,byte_size,status FROM character_container_drafts WHERE id=?',
  )
    .bind(id)
    .first<ContainerRow>();
  if (!row || row.owner_id !== owner) return error('私有原文件不存在', 404);

  if (request.method === 'HEAD' && pathname.endsWith('/content')) {
    if (row.status !== 'ready' || !(await env.PORTRAITS.head(row.object_key)))
      return error('私有原文件暂不可用', 503);
    return new Response(null, { status: 204, headers: HEADERS });
  }

  if (request.method === 'DELETE' && !pathname.endsWith('/content')) {
    if (row.status === 'deleting') return new Response(null, { status: 204, headers: HEADERS });
    if (row.status !== 'ready') return error('原文件仍在上传，请稍后重试', 409);
    const reserved = await env.DB.prepare(
      "UPDATE character_container_drafts SET status='deleting' WHERE id=? AND owner_id=? AND status='ready'",
    )
      .bind(id, owner)
      .run();
    if (!reserved.meta.changes) return error('原文件状态已变化，请重试', 409);
    try {
      await env.PORTRAITS.delete(row.object_key);
      await env.DB.prepare(
        "DELETE FROM character_container_drafts WHERE id=? AND status='deleting'",
      )
        .bind(id)
        .run();
    } catch (reason) {
      console.error('market_container_delete_retry_needed', id, reason);
      return error('原文件删除处理中，请稍后查看', 503);
    }
    return new Response(null, { status: 204, headers: HEADERS });
  }
  if (request.method !== 'GET' || !pathname.endsWith('/content')) return null;
  if (row.status !== 'ready') return error('私有原文件暂不可用', 503);
  const object = await env.PORTRAITS.get(row.object_key);
  if (!object) return error('私有原文件暂不可用', 503);
  return new Response(object.body, {
    headers: {
      ...HEADERS,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="character.${row.mime === 'image/png' ? 'png' : 'charx'}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

export async function cleanUnfinishedCharacterContainers(
  env: Pick<ContainerEnv, 'DB' | 'PORTRAITS'>,
  now = Date.now(),
): Promise<void> {
  await env.DB.prepare('DELETE FROM character_container_upload_events WHERE created_at<?')
    .bind(now - 2 * 86_400_000)
    .run();
  const rows = await env.DB.prepare(
    "SELECT id,object_key FROM character_container_drafts WHERE status='deleting' OR (status='uploading' AND created_at<?) LIMIT 100",
  )
    .bind(now - 86_400_000)
    .all<Pick<ContainerRow, 'id' | 'object_key'>>();
  for (const row of rows.results ?? []) {
    try {
      await env.PORTRAITS.delete(row.object_key);
      await env.DB.prepare(
        "DELETE FROM character_container_drafts WHERE id=? AND status IN ('uploading','deleting')",
      )
        .bind(row.id)
        .run();
    } catch (reason) {
      console.error('market_container_cleanup_retry_needed', row.id, reason);
    }
  }
}

/** Daily bounded owner scan; a deleted Auth account can no longer retain this R2 prefix. */
export async function purgeDeletedAccountContainers(
  env: ContainerEnv,
  now = Date.now(),
): Promise<void> {
  const owners = await env.DB.prepare(
    `SELECT owner_id,MIN(last_checked_at) AS checked FROM character_container_drafts
     GROUP BY owner_id ORDER BY checked,owner_id LIMIT 100`,
  ).all<{ owner_id: string; checked: number }>();
  for (const owner of owners.results ?? []) {
    try {
      if (await env.AUTH.marketAccountActive(owner.owner_id)) {
        await env.DB.prepare(
          'UPDATE character_container_drafts SET last_checked_at=? WHERE owner_id=?',
        )
          .bind(now, owner.owner_id)
          .run();
        continue;
      }
      const rows = await env.DB.prepare(
        'SELECT id,object_key FROM character_container_drafts WHERE owner_id=?',
      )
        .bind(owner.owner_id)
        .all<Pick<ContainerRow, 'id' | 'object_key'>>();
      for (const row of rows.results ?? []) {
        await env.DB.prepare("UPDATE character_container_drafts SET status='deleting' WHERE id=?")
          .bind(row.id)
          .run();
        await env.PORTRAITS.delete(row.object_key);
        await env.DB.prepare(
          "DELETE FROM character_container_drafts WHERE id=? AND status='deleting'",
        )
          .bind(row.id)
          .run();
      }
    } catch (reason) {
      console.error('market_container_account_purge_retry_needed', owner.owner_id, reason);
    }
  }
}
