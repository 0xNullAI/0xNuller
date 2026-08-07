// R2 媒体上传 / 读回。
// key 约定：room/{code}/{id}，mime 存在 R2 httpMetadata，房间清理时按 `room/{code}/` 前缀批量删。
import type { Env } from './index';
import { MAX_MEDIA_BYTES, ALLOWED_MEDIA_PREFIXES } from './wire';

function mediaKey(code: string, id: string): string {
  return `room/${code}/${id}`;
}

/** PUT /api/upload/:code?id=<id>  body=二进制，Content-Type=mime。 */
export async function handleMediaUpload(request: Request, env: Env, code: string): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return json(400, { error: 'invalid id' });
  }

  const mime = request.headers.get('Content-Type') ?? '';
  if (!ALLOWED_MEDIA_PREFIXES.some(p => mime.startsWith(p))) {
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

/** GET /api/media/:code/:id 读回媒体，带 content-type 与长缓存。 */
export async function handleMediaRead(env: Env, code: string, id: string): Promise<Response> {
  const obj = await env.MEDIA.get(mediaKey(code, id));
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', obj.httpEtag);
  return new Response(obj.body, { headers });
}

/** 删除某房间全部媒体（RoomDO 清理时调用）。 */
export async function deleteRoomMedia(env: Env, code: string): Promise<void> {
  const prefix = `room/${code}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.MEDIA.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await env.MEDIA.delete(listed.objects.map(o => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
