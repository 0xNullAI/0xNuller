import { currentUser } from './session-domain';
import { err, json, readBodyBounded } from './http';

const PATH = '/api/auth/push/registrations';
const INSTALLATION_ID = /^[A-Za-z0-9_-]{16,256}$/;
const INSTALLATION_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TARGET_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface PushEnv {
  DB: D1Database;
  /** Existing Auth→Chat service binding, used to recheck group membership at send time. */
  CHAT?: Fetcher;
  /** Full service-account JSON, configured only as a Worker Secret. */
  FCM_SERVICE_ACCOUNT_JSON?: string;
}

export interface ChatPushEvent {
  kind: 'dm' | 'group';
  targetId: string;
  eventId: string;
  senderAccountId: string;
  recipientAccountIds: string[];
}

export async function handlePushRegistrations(
  request: Request,
  env: PushEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== PATH && !path.startsWith(`${PATH}/`)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  // A browser cookie alone must not silently bind a push destination. Android sends Bearer.
  if (!request.headers.get('Authorization')?.startsWith('Bearer '))
    return err('请先登录', 401, headers);
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at != null) return err('账号不可用', 403, headers);
  const claimed = request.headers.get('X-Account-Id');
  if (claimed !== null && claimed !== user.id) return err('账号已切换', 403, headers);
  if (path === PATH && request.method === 'PUT') {
    const bytes = await readBodyBounded(request, 1024);
    if (!bytes) return err('请求过大', 413, headers);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      // `null`, numbers and arrays parse fine but are not a request object.
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    } catch {
      return err('请求无效', 400, headers);
    }
    if (
      body.provider !== 'fcm-fid' ||
      body.platform !== 'android' ||
      typeof body.installationId !== 'string' ||
      !INSTALLATION_ID.test(body.installationId) ||
      (body.installationKey !== undefined &&
        (typeof body.installationKey !== 'string' ||
          !INSTALLATION_KEY.test(body.installationKey))) ||
      (body.previousInstallationId !== undefined &&
        (typeof body.previousInstallationId !== 'string' ||
          !INSTALLATION_ID.test(body.previousInstallationId)))
    )
      return err('推送安装信息无效', 400, headers);
    const id = body.installationId;
    const installationKey = (body.installationKey as string | undefined) ?? null;
    const previousId = (body.previousInstallationId as string | undefined) ?? null;
    const existing = await env.DB.prepare(
      'SELECT user_id FROM push_registrations WHERE installation_id=?',
    )
      .bind(id)
      .first<{ user_id: string }>();
    const replacing = installationKey
      ? await env.DB.prepare(
          'SELECT installation_id FROM push_registrations WHERE user_id=? AND installation_key=?',
        )
          .bind(user.id, installationKey)
          .first()
      : null;
    const replacingLegacy = previousId
      ? await env.DB.prepare(
          'SELECT installation_id FROM push_registrations WHERE user_id=? AND installation_id=?',
        )
          .bind(user.id, previousId)
          .first()
      : null;
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM push_registrations WHERE user_id=?',
    )
      .bind(user.id)
      .first<{ n: number }>();
    if (existing?.user_id !== user.id && !replacing && !replacingLegacy && (count?.n ?? 0) >= 10)
      return err('推送设备数量已达上限', 409, headers);
    const now = Date.now();
    await env.DB.batch([
      // A rotation deletes only this authenticated account's old destination.
      // The batch rolls back both deletion and insertion on any SQL failure.
      env.DB.prepare(
        'DELETE FROM push_registrations WHERE user_id=? AND installation_key=? AND installation_id<>?',
      ).bind(user.id, installationKey, id),
      env.DB.prepare(
        'DELETE FROM push_registrations WHERE user_id=? AND installation_id=? AND installation_id<>?',
      ).bind(user.id, previousId, id),
      env.DB.prepare(
        `INSERT INTO push_registrations(installation_id,user_id,provider,platform,created_at,updated_at,installation_key)
         SELECT ?,?,'fcm-fid','android',?,?,?
         WHERE (SELECT COUNT(*) FROM push_registrations WHERE user_id=?)<10
           OR EXISTS(SELECT 1 FROM push_registrations WHERE installation_id=? AND user_id=?)
         ON CONFLICT(installation_id) DO UPDATE SET
           user_id=excluded.user_id,updated_at=excluded.updated_at,
            installation_key=CASE WHEN push_registrations.user_id=excluded.user_id
              THEN COALESCE(excluded.installation_key,push_registrations.installation_key)
             ELSE excluded.installation_key END`,
      ).bind(id, user.id, now, now, installationKey, user.id, id, user.id),
      env.DB.prepare(
        `DELETE FROM push_deliveries WHERE installation_id=? AND user_id<>?
         AND EXISTS(SELECT 1 FROM push_registrations WHERE installation_id=? AND user_id=?)`,
      ).bind(id, user.id, id, user.id),
    ]);
    // The earlier count gives a fast 409, but another registration can reach
    // this batch after that read. The INSERT guard is evaluated inside the
    // batch transaction; never report success when it rejected a late race.
    const registered = await env.DB.prepare(
      'SELECT user_id FROM push_registrations WHERE installation_id=?',
    )
      .bind(id)
      .first<{ user_id: string }>();
    if (registered?.user_id !== user.id) return err('推送设备数量已达上限', 409, headers);
    return json({ ok: true }, 200, headers);
  }
  if (path.startsWith(`${PATH}/`) && request.method === 'DELETE') {
    const id = path.slice(PATH.length + 1);
    if (!INSTALLATION_ID.test(id)) return err('推送安装信息无效', 400, headers);
    let installationKey: string | null = null;
    let previousId: string | null = null;
    if (request.body) {
      const bytes = await readBodyBounded(request, 1024);
      if (!bytes) return err('请求过大', 413, headers);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      } catch {
        return err('请求无效', 400, headers);
      }
      if (
        (body.installationKey !== undefined &&
          (typeof body.installationKey !== 'string' ||
            !INSTALLATION_KEY.test(body.installationKey))) ||
        (body.previousInstallationId !== undefined &&
          (typeof body.previousInstallationId !== 'string' ||
            !INSTALLATION_ID.test(body.previousInstallationId)))
      )
        return err('推送安装信息无效', 400, headers);
      installationKey = (body.installationKey as string | undefined) ?? null;
      previousId = (body.previousInstallationId as string | undefined) ?? null;
    }
    await env.DB.prepare(
      `DELETE FROM push_registrations WHERE user_id=? AND
       (installation_id=? OR installation_key=? OR installation_id=?)`,
    )
      .bind(user.id, id, installationKey, previousId)
      .run();
    return json({ ok: true }, 200, headers);
  }
  return err('接口不存在', 404, headers);
}

/** Called only over Chat's named WorkerEntrypoint binding, never from public HTTP. */
export async function enqueueChatPush(env: PushEnv, event: ChatPushEvent): Promise<void> {
  if (
    !['dm', 'group'].includes(event.kind) ||
    !TARGET_ID.test(event.targetId) ||
    !EVENT_ID.test(event.eventId) ||
    !ACCOUNT_ID.test(event.senderAccountId) ||
    !Array.isArray(event.recipientAccountIds) ||
    event.recipientAccountIds.length > 200 ||
    event.recipientAccountIds.some((id) => !ACCOUNT_ID.test(id))
  )
    throw new Error('invalid chat push event');
  const recipients = [...new Set(event.recipientAccountIds)].filter(
    (id) => id !== event.senderAccountId,
  );
  if (recipients.length === 0) return;
  const now = Date.now();
  await env.DB.batch(
    recipients.map((recipient) =>
      env.DB.prepare(
        `INSERT INTO push_deliveries(installation_id,user_id,kind,target_id,event_id,created_at,next_attempt_at)
         SELECT p.installation_id,p.user_id,?,?,?,?,? FROM push_registrations p JOIN users u ON u.id=p.user_id
         WHERE p.user_id=? AND u.banned_at IS NULL
         AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=p.user_id)
         ON CONFLICT(installation_id,kind,target_id,event_id) DO NOTHING`,
      ).bind(event.kind, event.targetId, event.eventId, now, now, recipient),
    ),
  );
}

export function prepareAiPushDelivery(
  env: PushEnv,
  userId: string,
  conversationId: string,
  messageId: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO push_deliveries(installation_id,user_id,kind,target_id,event_id,created_at,next_attempt_at)
     SELECT p.installation_id,p.user_id,'ai',?,?,?,? FROM push_registrations p
     JOIN server_conversation_messages m ON m.user_id=p.user_id AND m.conversation_id=? AND m.id=? AND m.role='assistant'
     JOIN users u ON u.id=p.user_id WHERE p.user_id=? AND u.banned_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=p.user_id)
     ON CONFLICT(installation_id,kind,target_id,event_id) DO NOTHING`,
  ).bind(conversationId, messageId, now, now, conversationId, messageId, userId);
}

async function dmPushStillAllowed(
  env: PushEnv,
  sender: string,
  recipient: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM users a JOIN users b ON b.id=? WHERE a.id=?
     AND a.banned_at IS NULL AND b.banned_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id IN (a.id,b.id))
     AND EXISTS(SELECT 1 FROM user_follows f WHERE f.follower_id=a.id AND f.followee_id=b.id)
     AND EXISTS(SELECT 1 FROM user_follows f WHERE f.follower_id=b.id AND f.followee_id=a.id)
     AND NOT EXISTS(SELECT 1 FROM user_blocks x WHERE
       (x.blocker_id=a.id AND x.blocked_id=b.id) OR (x.blocker_id=b.id AND x.blocked_id=a.id))`,
  )
    .bind(recipient, sender)
    .first();
  return Boolean(row);
}

async function groupPushStillAllowed(
  env: PushEnv,
  room: string,
  account: string,
): Promise<boolean> {
  if (!env.CHAT) throw new Error('Chat membership check unavailable');
  const response = await env.CHAT.fetch('https://chat.internal/internal/push/group-eligible', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, account }),
  });
  if (!response.ok) throw new Error(`Chat membership check ${response.status}`);
  const result = (await response.json()) as { eligible?: boolean };
  return result.eligible === true;
}

async function aiPushStillAllowed(
  env: PushEnv,
  account: string,
  conversation: string,
  message: string,
): Promise<boolean> {
  // A queued reply can outlive a deleted conversation. Check the exact reply
  // again at delivery time so a stale notification does not reopen it.
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM server_conversation_messages m
     JOIN server_conversations c ON c.user_id=m.user_id AND c.id=m.conversation_id
     WHERE m.user_id=? AND m.conversation_id=? AND m.id=? AND m.role='assistant'
     AND c.deleted_at IS NULL`,
  )
    .bind(account, conversation, message)
    .first();
  return Boolean(row);
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}
let cachedToken: { identity: string; token: string; expiresAt: number } | null = null;
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

async function accessToken(
  secret: string,
  now: number,
): Promise<{ projectId: string; token: string }> {
  const account = JSON.parse(secret) as ServiceAccount;
  if (!account.project_id || !account.client_email || !account.private_key)
    throw new Error('FCM service account unavailable');
  const identity = `${account.project_id}:${account.client_email}`;
  if (cachedToken?.identity === identity && cachedToken.expiresAt > now + 60_000)
    return { projectId: account.project_id, token: cachedToken.token };
  const pem = account.private_key.replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
    '',
  );
  const keyBytes = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 3600,
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)),
  );
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${base64url(signature)}`,
    }),
  });
  if (!response.ok) throw new Error(`FCM OAuth ${response.status}`);
  const result = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!result.access_token) throw new Error('FCM OAuth token unavailable');
  cachedToken = {
    identity,
    token: result.access_token,
    expiresAt: now + Math.min(3600, result.expires_in ?? 3600) * 1000,
  };
  return { projectId: account.project_id, token: result.access_token };
}

export async function runPushDeliveries(env: PushEnv, now = Date.now()): Promise<void> {
  // The main message is already durable. This outbox can retry independently of chat/schedule writes.
  // During staged rollout, absent credentials leave deliveries pending rather than exhausting retries.
  if (!env.FCM_SERVICE_ACCOUNT_JSON) return;
  const rows = await env.DB.prepare(
    `SELECT d.installation_id AS installationId,d.user_id AS userId,d.kind,d.target_id AS targetId,d.event_id AS eventId,d.attempts
     FROM push_deliveries d JOIN push_registrations p ON p.installation_id=d.installation_id AND p.user_id=d.user_id
     JOIN users u ON u.id=d.user_id
     WHERE d.sent_at IS NULL AND d.dead_at IS NULL AND d.next_attempt_at<=? AND COALESCE(d.lease_until,0)<=?
     AND u.banned_at IS NULL AND NOT EXISTS(SELECT 1 FROM account_deletions a WHERE a.user_id=d.user_id)
     ORDER BY d.next_attempt_at LIMIT 100`,
  )
    .bind(now, now)
    .all<{
      installationId: string;
      userId: string;
      kind: 'ai' | 'dm' | 'group';
      targetId: string;
      eventId: string;
      attempts: number;
    }>();
  for (const row of rows.results) {
    const lease = await env.DB.prepare(
      `UPDATE push_deliveries SET lease_until=? WHERE installation_id=? AND kind=? AND target_id=? AND event_id=?
       AND sent_at IS NULL AND dead_at IS NULL AND next_attempt_at<=? AND COALESCE(lease_until,0)<=?
       RETURNING installation_id`,
    )
      .bind(now + 60_000, row.installationId, row.kind, row.targetId, row.eventId, now, now)
      .first();
    if (!lease) continue;
    const stillOwned = await env.DB.prepare(
      'SELECT 1 AS ok FROM push_registrations WHERE installation_id=? AND user_id=?',
    )
      .bind(row.installationId, row.userId)
      .first();
    if (!stillOwned) continue;
    let sent = false;
    let permanent = false;
    let obsolete = false;
    try {
      if (row.kind === 'ai')
        obsolete = !(await aiPushStillAllowed(env, row.userId, row.targetId, row.eventId));
      if (row.kind === 'dm') obsolete = !(await dmPushStillAllowed(env, row.targetId, row.userId));
      if (row.kind === 'group')
        obsolete = !(await groupPushStillAllowed(env, row.targetId, row.userId));
      if (obsolete) {
        await env.DB.prepare(
          'DELETE FROM push_deliveries WHERE installation_id=? AND kind=? AND target_id=? AND event_id=? AND lease_until=?',
        )
          .bind(row.installationId, row.kind, row.targetId, row.eventId, now + 60_000)
          .run();
        continue;
      }
      const { projectId, token } = await accessToken(env.FCM_SERVICE_ACCOUNT_JSON, now);
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              fid: row.installationId,
              data: {
                kind: row.kind,
                targetId: row.targetId,
                eventId: row.eventId,
                accountId: row.userId,
              },
              // Every push here is a message a person or their AI sent; normal priority can
              // sit in Doze for hours, which defeats a chat notification.
              android: { priority: 'high', ttl: '86400s' },
            },
          }),
        },
      );
      sent = response.ok;
      if (response.status === 404) {
        const failure = (await response.json().catch(() => null)) as {
          error?: { status?: string };
        } | null;
        permanent = failure?.error?.status === 'UNREGISTERED';
      }
    } catch {
      // Network and configuration failures retain the outbox event for cron retry.
    }
    if (permanent) {
      // FCM no longer recognizes this FID. The FK cascade removes all queued events for it.
      await env.DB.prepare('DELETE FROM push_registrations WHERE installation_id=? AND user_id=?')
        .bind(row.installationId, row.userId)
        .run();
      continue;
    }
    const attempts = row.attempts + 1;
    if (!sent && attempts >= 8)
      console.error(JSON.stringify({ event: 'push_delivery_abandoned', kind: row.kind, attempts }));
    await env.DB.prepare(
      `UPDATE push_deliveries SET attempts=?,lease_until=NULL,sent_at=?,dead_at=?,next_attempt_at=?
       WHERE installation_id=? AND kind=? AND target_id=? AND event_id=? AND lease_until=?`,
    )
      .bind(
        attempts,
        sent ? now : null,
        !sent && (permanent || attempts >= 8) ? now : null,
        now + Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts - 1, 6)),
        row.installationId,
        row.kind,
        row.targetId,
        row.eventId,
        now + 60_000,
      )
      .run();
  }
  await env.DB.prepare(
    'DELETE FROM push_deliveries WHERE COALESCE(sent_at,dead_at,0)>0 AND COALESCE(sent_at,dead_at,0)<?',
  )
    .bind(now - 14 * 86_400_000)
    .run();
}
