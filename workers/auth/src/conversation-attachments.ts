import { sanitizePhoto } from '@0xnullai/auth/photo-sanitizer';
import { err, json, readBodyBounded } from './http';
import { currentUser, type SessionEnv } from './session-domain';

const ROOT = '/api/auth/conversations/';
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VOICE_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4']);
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_VOICE_BYTES = 10_000_000;
const VOICE_CAPTION_PREFIX = '用户为语音附上的文字（未自动核对音频）：';

type AttachmentRow = {
  id: string;
  message_id: string | null;
  status: 'pending' | 'ready';
  kind: 'image' | 'voice';
  mime: string;
  size: number;
  object_key: string;
  created_at: number;
  caption?: string | null;
};

type AttachmentEnv = SessionEnv & { PHOTOS: R2Bucket };

function publicAttachment(row: AttachmentRow, conversationId: string) {
  return {
    id: row.id,
    messageId: row.message_id,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    createdAt: row.created_at,
    contentUrl: `${ROOT}${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(row.id)}/content`,
    caption:
      row.kind === 'voice' && row.caption?.startsWith(VOICE_CAPTION_PREFIX)
        ? row.caption.slice(VOICE_CAPTION_PREFIX.length)
        : null,
  };
}

function validVoice(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'audio/ogg')
    return bytes.length > 4 && String.fromCharCode(...bytes.slice(0, 4)) === 'OggS';
  if (mime === 'audio/webm')
    return (
      bytes.length > 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    );
  return (
    bytes.length > 12 &&
    String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp' &&
    ['M4A ', 'mp42', 'isom'].includes(String.fromCharCode(...bytes.slice(8, 12)))
  );
}

/** Upload bytes first, then explicitly commit their user message after the client rechecks identity. */
export async function handleConversationAttachments(
  request: Request,
  env: AttachmentEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const match = path.match(
    /^\/api\/auth\/conversations\/([^/]+)\/attachments(?:\/([^/]+)\/(content|commit))?$/,
  );
  if (!match) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  let conversationId: string;
  let attachmentId: string | undefined;
  try {
    conversationId = decodeURIComponent(match[1]!);
    attachmentId = match[2] ? decodeURIComponent(match[2]) : undefined;
  } catch {
    return err('编号无效', 400, headers);
  }
  if (!ID.test(conversationId) || (attachmentId && !ID.test(attachmentId)))
    return err('编号无效', 400, headers);
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at != null) return err('账号不可用', 403, headers);
  if (request.headers.get('X-Account-Id') !== user.id)
    return err('账号已切换，请重新打开会话', 403, headers);
  const conversation = await env.DB.prepare(
    'SELECT id,revision FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL',
  )
    .bind(user.id, conversationId)
    .first<{ id: string; revision: number }>();
  if (!conversation) return err('会话不存在或已删除', 404, headers);

  if (attachmentId) {
    if (match[3] === 'commit') {
      if (request.method !== 'POST') return err('不支持此操作', 405, headers);
      const rawBody = await readBodyBounded(request, 5000);
      if (!rawBody) return err('语音文字过长', 413, headers);
      let caption = '';
      if (rawBody.byteLength) {
        try {
          const body = JSON.parse(new TextDecoder().decode(rawBody)) as { caption?: unknown };
          if (typeof body.caption !== 'string') throw new Error('invalid caption');
          caption = body.caption.trim();
        } catch {
          return err('语音文字格式无效', 400, headers);
        }
      }
      if (caption.length > 2000) return err('语音文字过长', 400, headers);
      const row = await env.DB.prepare(
        `SELECT a.id,a.message_id,a.status,a.kind,a.mime,a.size,a.object_key,a.created_at,m.content AS caption
         FROM private_conversation_attachments a LEFT JOIN server_conversation_messages m
           ON m.user_id=a.user_id AND m.conversation_id=a.conversation_id AND m.id=a.message_id
         WHERE a.user_id=? AND a.conversation_id=? AND a.id=?`,
      )
        .bind(user.id, conversationId, attachmentId)
        .first<AttachmentRow>();
      if (!row) return err('附件不存在', 404, headers);
      if (caption && row.kind !== 'voice') return err('图片不能附加语音文字', 400, headers);
      if (row.status === 'ready')
        return json({ attachment: publicAttachment(row, conversationId) }, 200, headers);
      const mutationId = crypto.randomUUID();
      const messageId = `attachment-${attachmentId}`;
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE server_conversations SET revision=revision+1,updated_at=MAX(updated_at+1,?),mutation_id=?
           WHERE user_id=? AND id=? AND deleted_at IS NULL AND revision=?`,
        ).bind(Date.now(), mutationId, user.id, conversationId, conversation.revision),
        env.DB.prepare(
          `INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position)
           SELECT ?,?,?,'user',?, ?,COALESCE((SELECT MAX(position)+1 FROM server_conversation_messages
             WHERE user_id=? AND conversation_id=?),0)
           WHERE EXISTS(SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND mutation_id=? AND deleted_at IS NULL)
             AND EXISTS(SELECT 1 FROM private_conversation_attachments WHERE user_id=? AND conversation_id=? AND id=? AND status='pending')`,
        ).bind(
          user.id,
          conversationId,
          messageId,
          caption ? `${VOICE_CAPTION_PREFIX}${caption}` : '',
          Date.now(),
          user.id,
          conversationId,
          user.id,
          conversationId,
          mutationId,
          user.id,
          conversationId,
          attachmentId,
        ),
        env.DB.prepare(
          `UPDATE private_conversation_attachments SET status='ready',message_id=?
           WHERE user_id=? AND conversation_id=? AND id=? AND status='pending'
             AND EXISTS(SELECT 1 FROM server_conversation_messages WHERE user_id=? AND conversation_id=? AND id=?)`,
        ).bind(
          messageId,
          user.id,
          conversationId,
          attachmentId,
          user.id,
          conversationId,
          messageId,
        ),
      ]);
      const saved = await env.DB.prepare(
        `SELECT a.id,a.message_id,a.status,a.kind,a.mime,a.size,a.object_key,a.created_at,m.content AS caption
         FROM private_conversation_attachments a LEFT JOIN server_conversation_messages m
           ON m.user_id=a.user_id AND m.conversation_id=a.conversation_id AND m.id=a.message_id
         WHERE a.user_id=? AND a.conversation_id=? AND a.id=? AND a.status='ready'`,
      )
        .bind(user.id, conversationId, attachmentId)
        .first<AttachmentRow>();
      return saved
        ? json({ attachment: publicAttachment(saved, conversationId) }, 201, headers)
        : err('会话已变更，请重试提交', 409, headers);
    }
    if (request.method !== 'GET') return err('不支持此操作', 405, headers);
    const row = await env.DB.prepare(
      "SELECT object_key,mime FROM private_conversation_attachments WHERE user_id=? AND conversation_id=? AND id=? AND status='ready'",
    )
      .bind(user.id, conversationId, attachmentId)
      .first<{ object_key: string; mime: string }>();
    if (!row) return err('附件不存在', 404, headers);
    const object = await env.PHOTOS.get(row.object_key);
    if (!object) return err('附件不可用', 404, headers);
    return new Response(object.body, {
      headers: {
        ...headers,
        'Content-Type': row.mime,
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    });
  }

  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT a.id,a.message_id,a.status,a.kind,a.mime,a.size,a.object_key,a.created_at,m.content AS caption
       FROM private_conversation_attachments a LEFT JOIN server_conversation_messages m
         ON m.user_id=a.user_id AND m.conversation_id=a.conversation_id AND m.id=a.message_id
       WHERE a.user_id=? AND a.conversation_id=? AND a.status='ready' ORDER BY a.created_at,a.id`,
    )
      .bind(user.id, conversationId)
      .all<AttachmentRow>();
    return json(
      { items: rows.results.map((row) => publicAttachment(row, conversationId)) },
      200,
      headers,
    );
  }
  if (request.method !== 'POST') return err('不支持此操作', 405, headers);
  const mime = (request.headers.get('content-type') ?? '').split(';', 1)[0]!.trim();
  const kind = IMAGE_TYPES.has(mime) ? 'image' : VOICE_TYPES.has(mime) ? 'voice' : null;
  if (!kind) return err('不支持的附件格式', 415, headers);
  const uploaded = await readBodyBounded(
    request,
    kind === 'image' ? MAX_IMAGE_BYTES : MAX_VOICE_BYTES,
  );
  if (!uploaded) return err('附件过大', 413, headers);
  if (uploaded.byteLength === 0) return err('附件为空', 400, headers);
  let bytes: Uint8Array;
  try {
    bytes = kind === 'image' ? sanitizePhoto(uploaded, mime) : new Uint8Array(uploaded);
    if (kind === 'voice' && !validVoice(bytes, mime)) throw new Error('invalid audio container');
  } catch {
    return err('附件格式或内容无效', 400, headers);
  }
  const attachmentIdNew = crypto.randomUUID();
  const objectKey = `users/${user.id}/conversations/${conversationId}/attachments/${attachmentIdNew}`;
  const now = Date.now();
  await env.PHOTOS.put(objectKey, bytes, { httpMetadata: { contentType: mime } });
  try {
    await env.DB.prepare(
      `INSERT INTO private_conversation_attachments
       (user_id,conversation_id,id,message_id,status,kind,mime,size,object_key,created_at)
       SELECT ?,?,?,NULL,'pending',?,?,?,?,? WHERE EXISTS
       (SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL)
       AND (SELECT COUNT(*) FROM private_conversation_attachments WHERE user_id=? AND conversation_id=?) < 1000
       AND (SELECT COALESCE(SUM(size),0) FROM private_conversation_attachments WHERE user_id=?) + ? <= 500000000`,
    )
      .bind(
        user.id,
        conversationId,
        attachmentIdNew,
        kind,
        mime,
        bytes.byteLength,
        objectKey,
        now,
        user.id,
        conversationId,
        user.id,
        conversationId,
        user.id,
        bytes.byteLength,
      )
      .run();
    const staged = await env.DB.prepare(
      "SELECT 1 FROM private_conversation_attachments WHERE user_id=? AND conversation_id=? AND id=? AND status='pending'",
    )
      .bind(user.id, conversationId, attachmentIdNew)
      .first();
    if (!staged) {
      await env.PHOTOS.delete(objectKey);
      return err('会话不可用或附件额度已满', 409, headers);
    }
  } catch (error) {
    await env.PHOTOS.delete(objectKey);
    throw error;
  }
  return json(
    {
      attachment: publicAttachment(
        {
          id: attachmentIdNew,
          message_id: null,
          status: 'pending',
          kind,
          mime,
          size: bytes.byteLength,
          object_key: objectKey,
          created_at: now,
        },
        conversationId,
      ),
    },
    201,
    headers,
  );
}

/** R2 deletion is retried independently after message/conversation/account cascades. */
export async function runConversationAttachmentCleanup(env: AttachmentEnv): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM private_conversation_attachments WHERE status='pending' AND created_at<?",
  )
    .bind(Date.now() - 24 * 60 * 60 * 1000)
    .run();
  const rows = await env.DB.prepare(
    'SELECT object_key FROM private_attachment_deletions ORDER BY queued_at,object_key LIMIT 100',
  ).all<{ object_key: string }>();
  for (const row of rows.results) {
    try {
      await env.PHOTOS.delete(row.object_key);
      await env.DB.prepare('DELETE FROM private_attachment_deletions WHERE object_key=?')
        .bind(row.object_key)
        .run();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'conversation_attachment_cleanup_failed',
          objectKey: row.object_key,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
