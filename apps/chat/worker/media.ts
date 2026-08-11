// R2 media upload / read-back.
// Key convention: room/{code}/{id}; the mime type lives in R2 httpMetadata, and the group's
// whole media set is enumerable by the `room/{code}/` prefix.
import type { Env } from './index';
import type { StoredMediaObject } from './group';
import { MAX_MEDIA_BYTES, isAllowedMediaType } from './wire';

function mediaKey(code: string, id: string): string {
  return `room/${code}/${id}`;
}

/** PUT /api/upload/:code?id=<id>  body=binary, Content-Type=mime. */
export async function handleMediaUpload(
  request: Request,
  env: Env,
  code: string,
): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(code)) {
    return json(400, { error: 'invalid room' });
  }
  const mediaToken = request.headers.get('x-media-token') ?? '';
  const room = env.ROOM.get(env.ROOM.idFromName(code));
  if (!(await room.authorizeMediaUpload(code, mediaToken))) {
    return json(403, { error: 'active room membership required' });
  }
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return json(400, { error: 'invalid id' });
  }

  const mime = request.headers.get('Content-Type') ?? '';
  if (!isAllowedMediaType(mime)) {
    return json(415, { error: 'unsupported media type' });
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return json(400, { error: 'empty body' });
  if (buf.byteLength > MAX_MEDIA_BYTES) return json(413, { error: 'too large' });

  const key = mediaKey(code, id);
  await env.MEDIA.put(key, buf, {
    httpMetadata: { contentType: mime },
  });

  try {
    // An upload can happen before its chat message. If the tab closes in between,
    // no WebSocket disconnect exists to schedule RoomDO's orphan sweep. Tell the
    // room about every successful object write so an otherwise-idle room still
    // reconciles its R2 prefix after the grace window.
    await room.noteMediaUpload(code, mediaToken);
  } catch {
    // Without a scheduled sweep this object has no guaranteed cleanup path.
    await env.MEDIA.delete(key);
    return json(503, { error: 'media cleanup unavailable' });
  }

  return json(200, { id, mime, size: buf.byteLength });
}

/** GET /api/media/:code/:id reads media back, with its content-type and a long cache. */
export async function handleMediaRead(env: Env, code: string, id: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(code) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return new Response('not found', { status: 404 });
  }
  const obj = await env.MEDIA.get(mediaKey(code, id));
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', obj.httpEtag);
  // Defense in depth behind the upload allow-list. This response is served
  // from the app's own origin, where the session cookie lives, so anything
  // stored here must not be able to become active content: nosniff stops the
  // browser inventing a richer type than we declared, and the CSP neuters
  // script and subresource loading even if some future type slips through.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(obj.body, { headers });
}

/**
 * Delete specific media objects of a group (called by RoomDO when their message rows go).
 *
 * There is no longer a "delete everything for this room" call: a group is permanent, so
 * media only ever leaves one message at a time, together with the row that referenced it.
 */
export async function deleteRoomMedia(env: Env, code: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await env.MEDIA.delete(ids.map((id) => mediaKey(code, id)));
}

/** Everything currently stored under a group's prefix, for the orphan sweep. */
export async function listRoomMedia(env: Env, code: string): Promise<StoredMediaObject[]> {
  const prefix = `room/${code}/`;
  const out: StoredMediaObject[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.MEDIA.list({ prefix, cursor });
    for (const o of listed.objects) {
      out.push({ id: o.key.slice(prefix.length), uploadedAt: o.uploaded.getTime() });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
