import { timingSafeEqual } from 'node:crypto';
import type { Env } from './index';
import { isDmRoomCode } from './dm';
import { validRoom, type RoomIndexKind } from './room-index';

const ROOM_CODE = /^[A-Za-z0-9._:-]{1,128}$/;
const MEDIA_KEY = /^room\/([^/]{1,128})\/([A-Za-z0-9_-]{1,64})$/;

function validMediaKey(key: string): boolean {
  const match = MEDIA_KEY.exec(key);
  return (
    !!match && (/^[A-Za-z0-9_-]{1,96}$/.test(match[1]!) || /^dm:[a-f0-9]{64}$/.test(match[1]!))
  );
}

function authorized(request: Request, secret: string | undefined): boolean {
  const supplied = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!secret || secret.length < 32 || !supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Operator-only export of explicitly identified rooms and a complete R2 object listing. */
export async function handleChatBackupExport(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env.CHAT_BACKUP_TOKEN)) return json(403, { error: 'forbidden' });
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  const route = new URL(request.url).pathname;
  const raw = await request.text();
  if (raw.length > (route === '/api/groups/backup/rooms/backfill' ? 16384 : 2048))
    return json(413, { error: 'request too large' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return json(400, { error: 'invalid request' });
  }

  if (route === '/api/groups/backup/messages') {
    const room = body.room;
    if (
      typeof room !== 'string' ||
      !ROOM_CODE.test(room) ||
      room.includes('/') ||
      (room.startsWith('dm:') && !isDmRoomCode(room))
    )
      return json(400, { error: 'invalid room' });
    const before = body.before;
    if (
      before !== undefined &&
      (!before ||
        typeof before !== 'object' ||
        Array.isArray(before) ||
        !Number.isSafeInteger((before as Record<string, unknown>).ts) ||
        Number((before as Record<string, unknown>).ts) < 0 ||
        typeof (before as Record<string, unknown>).id !== 'string' ||
        String((before as Record<string, unknown>).id).length === 0 ||
        String((before as Record<string, unknown>).id).length > 256)
    )
      return json(400, { error: 'invalid cursor' });
    const snapshot = await env.ROOM.get(env.ROOM.idFromName(room)).exportBackupMessages(
      room,
      before as { ts: number; id: string } | undefined,
    );
    if (!snapshot.exists) return json(409, { error: 'room identity not found' });
    return json(200, snapshot);
  }

  if (route === '/api/groups/backup/rooms') {
    if (
      body.after !== undefined &&
      (typeof body.after !== 'string' ||
        body.after.length > 128 ||
        (body.after !== '' && !ROOM_CODE.test(body.after)))
    )
      return json(400, { error: 'invalid cursor' });
    const page = await env.ROOM_INDEX.get(env.ROOM_INDEX.idFromName('all-rooms')).list(
      body.after as string | undefined,
    );
    return json(200, { ...page, coverage: 'observed-and-explicit-hints' });
  }

  if (route === '/api/groups/backup/account-tombstones') {
    if (body.after !== undefined && (typeof body.after !== 'string' || body.after.length > 256))
      return json(400, { error: 'invalid cursor' });
    return json(
      200,
      await env.ROOM_INDEX.get(env.ROOM_INDEX.idFromName('all-rooms')).listAccountTombstones(
        body.after as string | undefined,
      ),
    );
  }

  if (route === '/api/groups/backup/rooms/backfill') {
    if (
      !Array.isArray(body.rooms) ||
      body.rooms.length < 1 ||
      body.rooms.length > 100 ||
      !body.rooms.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          validRoom((item as { code: string }).code, (item as { kind: RoomIndexKind }).kind),
      )
    )
      return json(400, { error: 'invalid rooms' });
    const registry = env.ROOM_INDEX.get(env.ROOM_INDEX.idFromName('all-rooms'));
    for (const item of body.rooms as { code: string; kind: RoomIndexKind }[])
      await registry.register(item.code, item.kind, 'historical-hint');
    return json(200, { accepted: body.rooms.length, coverage: 'operator-supplied-hints' });
  }

  if (route === '/api/groups/backup/media-list') {
    if (body.cursor !== undefined && (typeof body.cursor !== 'string' || body.cursor.length > 2048))
      return json(400, { error: 'invalid cursor' });
    const listed = await env.MEDIA.list({ cursor: body.cursor as string | undefined, limit: 1000 });
    return json(200, {
      objects: listed.objects.map((object) => ({
        key: object.key,
        size: object.size,
        etag: object.etag,
        uploaded: object.uploaded.toISOString(),
      })),
      cursor: listed.truncated ? listed.cursor : null,
    });
  }

  if (route === '/api/groups/backup/media') {
    if (typeof body.key !== 'string' || !validMediaKey(body.key))
      return json(400, { error: 'invalid media key' });
    const object = await env.MEDIA.get(body.key);
    if (!object) return json(404, { error: 'not found' });
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Backup-Etag': object.etag,
      },
    });
  }

  return json(404, { error: 'not found' });
}
