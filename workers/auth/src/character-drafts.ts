import { parseCharacterDraft } from '@0xnullai/scenes/character-draft';
import { err, json, readBodyBounded } from './http';
import { currentUser, type SessionEnv } from './session-domain';

const PATH = /^\/api\/auth\/character-drafts\/(new|[\w-]{1,128})$/;
const MAX_BODY_BYTES = 520_000;

export async function handleCharacterDrafts(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  const headers = {
    ...cors,
    'Cache-Control': 'private, no-store',
    Vary: 'Origin, Cookie, Authorization, X-Account-Id',
  };
  if (!['GET', 'PUT', 'DELETE'].includes(request.method)) return err('不支持此操作', 405, headers);
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at != null) return err('账户不可用', 403, headers);
  const claimedAccount = request.headers.get('X-Account-Id');
  if (claimedAccount && claimedAccount !== user.id)
    return err('账户已变化，请刷新后重试', 409, headers);
  if (request.method !== 'GET' && claimedAccount !== user.id)
    return err('账户已变化，请刷新后重试', 409, headers);
  const key = match[1] === 'new' ? '' : match[1]!;

  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT content, revision, updated_at FROM character_drafts WHERE user_id=? AND item_key=?',
    )
      .bind(user.id, key)
      .first<{ content: string; revision: number; updated_at: number }>();
    return json(
      row
        ? {
            draft: JSON.parse(row.content),
            revision: row.revision,
            updatedAt: row.updated_at,
            accountId: user.id,
          }
        : { draft: null, accountId: user.id },
      200,
      headers,
    );
  }

  if (request.method === 'DELETE') {
    const revision = Number(url.searchParams.get('revision'));
    if (!Number.isSafeInteger(revision) || revision < 1) return err('草稿版本无效', 400, headers);
    const deleted = await env.DB.prepare(
      'DELETE FROM character_drafts WHERE user_id=? AND item_key=? AND revision=? RETURNING revision',
    )
      .bind(user.id, key, revision)
      .first();
    return deleted
      ? json({ ok: true, accountId: user.id }, 200, headers)
      : err('草稿已在其他设备更新，请刷新', 409, headers);
  }

  if (key && user.role !== 'admin') {
    const claim = await env.DB.prepare(
      'SELECT 1 FROM market_claims WHERE item_id=? AND user_id=? AND verified_at IS NOT NULL',
    )
      .bind(key, user.id)
      .first();
    if (!claim) return err('无权编辑此角色', 403, headers);
  }
  const bytes = await readBodyBounded(request, MAX_BODY_BYTES);
  if (!bytes) return err('草稿内容过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return err('草稿格式错误', 400, headers);
  }
  const expectedRevision = body.expectedRevision;
  const draft = parseCharacterDraft(body.draft);
  if (
    Object.keys(body).some((field) => !['expectedRevision', 'draft'].includes(field)) ||
    !Number.isSafeInteger(expectedRevision) ||
    (expectedRevision as number) < 0 ||
    !draft
  )
    return err('草稿内容无效或超出限制', 400, headers);

  if (draft.sourceFileId) {
    if (!env.MARKET) return err('私有原文件归属验证暂不可用', 503, headers);
    const verificationHeaders = new Headers({ 'X-Account-Id': user.id });
    for (const name of ['Authorization', 'Cookie']) {
      const value = request.headers.get(name);
      if (value) verificationHeaders.set(name, value);
    }
    let verification: Response;
    try {
      verification = await env.MARKET.fetch(
        new Request(
          `https://market.internal/api/items/character-container-drafts/${draft.sourceFileId}/content`,
          { method: 'HEAD', headers: verificationHeaders },
        ),
      );
    } catch {
      return err('私有原文件归属验证暂不可用', 503, headers);
    }
    if (verification.status !== 204)
      return err(
        '私有原文件不属于当前账户或已不可用',
        [401, 404].includes(verification.status) ? 400 : 503,
        headers,
      );
  }

  const now = Date.now();
  const revision = expectedRevision as number;
  const row =
    revision === 0
      ? await env.DB.prepare(
          `INSERT INTO character_drafts(user_id,item_key,content,revision,updated_at)
         SELECT ?,?,?,1,? WHERE (SELECT COUNT(*) FROM character_drafts WHERE user_id=?)<100
         AND NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?)
         ON CONFLICT(user_id,item_key) DO NOTHING RETURNING revision`,
        )
          .bind(user.id, key, JSON.stringify(draft), now, user.id, user.id)
          .first<{ revision: number }>()
      : await env.DB.prepare(
          `UPDATE character_drafts SET content=?,revision=revision+1,updated_at=?
         WHERE user_id=? AND item_key=? AND revision=?
         AND NOT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?) RETURNING revision`,
        )
          .bind(JSON.stringify(draft), now, user.id, key, revision, user.id)
          .first<{ revision: number }>();
  return row
    ? json({ revision: row.revision, updatedAt: now, accountId: user.id }, 200, headers)
    : err('草稿已在其他设备更新或达到数量上限，请刷新', 409, headers);
}
