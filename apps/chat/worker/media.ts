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
export async function handleMediaUpload(request: Request, env: Env, code: string): Promise<Response> {
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

  await env.MEDIA.put(mediaKey(code, id), buf, {
    httpMetadata: { contentType: mime },
  });

  return json(200, { id, mime, size: buf.byteLength });
}

/** GET /api/media/:code/:id reads media back, with its content-type and a long cache. */
export async function handleMediaRead(env: Env, code: string, id: string): Promise<Response> {
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
  await env.MEDIA.delete(ids.map(id => mediaKey(code, id)));
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
    headers: { 'Content-Type': 'application/json' },
  });
}
