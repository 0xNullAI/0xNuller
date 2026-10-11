type BackupEnv = { DB: D1Database; PHOTOS: R2Bucket; AUTH_BACKUP_TOKEN?: string };
const PREFIX = '/api/auth/backup/attachments/';
const KEY =
  /^users\/[A-Za-z0-9._:-]{1,128}\/conversations\/[A-Za-z0-9._:-]{1,128}\/attachments\/[A-Za-z0-9._:-]{1,128}$/;

function authorized(request: Request, secret: string | undefined): boolean {
  const supplied = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!secret || secret.length < 32 || !supplied) return false;
  if (supplied.length !== secret.length) return false;
  let difference = 0;
  for (let index = 0; index < secret.length; index++)
    difference |= supplied.charCodeAt(index) ^ secret.charCodeAt(index);
  return difference === 0;
}

function response(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Operator-only enumeration of ready private AI attachments and their bytes. */
export async function handleAuthChatBackupExport(
  request: Request,
  env: BackupEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(PREFIX)) return null;
  if (!authorized(request, env.AUTH_BACKUP_TOKEN)) return response(403, { error: 'forbidden' });
  if (request.method !== 'POST') return response(405, { error: 'method not allowed' });
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 2048) return response(413, { error: 'request too large' });
    body = JSON.parse(raw) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return response(400, { error: 'invalid request' });
  }

  if (path === `${PREFIX}list`) {
    if (
      body.after !== undefined &&
      (typeof body.after !== 'string' ||
        body.after.length > 512 ||
        (body.after !== '' && !KEY.test(body.after)))
    )
      return response(400, { error: 'invalid cursor' });
    const rows = await env.DB.prepare(
      `SELECT object_key,size,mime FROM private_conversation_attachments
      WHERE status='ready' AND object_key>? ORDER BY object_key LIMIT 101`,
    )
      .bind(body.after ?? '')
      .all<{ object_key: string; size: number; mime: string }>();
    const page = rows.results.slice(0, 100);
    return response(200, {
      objects: page.map((row) => ({ key: row.object_key, size: row.size, mime: row.mime })),
      cursor: rows.results.length > 100 ? page.at(-1)?.object_key : null,
    });
  }

  if (path === `${PREFIX}content` || path === `${PREFIX}head`) {
    if (typeof body.key !== 'string' || !KEY.test(body.key))
      return response(400, { error: 'invalid key' });
    const row = await env.DB.prepare(
      `SELECT size,mime FROM private_conversation_attachments
      WHERE object_key=? AND status='ready'`,
    )
      .bind(body.key)
      .first<{ size: number; mime: string }>();
    if (!row) return response(404, { error: 'not found' });
    if (path === `${PREFIX}head`) {
      const object = await env.PHOTOS.head(body.key);
      if (!object) return response(404, { error: 'not found' });
      if (object.size !== row.size) return response(409, { error: 'object changed' });
      return response(200, { key: body.key, size: object.size, mime: row.mime, etag: object.etag });
    }
    const object = await env.PHOTOS.get(body.key);
    if (!object) return response(404, { error: 'not found' });
    if (object.size !== row.size) return response(409, { error: 'object changed' });
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Backup-Etag': object.etag,
        'X-Backup-Size': String(object.size),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  return response(404, { error: 'not found' });
}
