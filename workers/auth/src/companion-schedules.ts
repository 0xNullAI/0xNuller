import {
  cleanupGenerations,
  prepareGeneration,
  generationSettlement,
  proactiveCapability,
  type GenerativeScheduleEnv,
} from './companion-generations';
import { currentUser } from './session-domain';
import { prepareAiPushDelivery } from './push';
import { json, err, readBodyBounded } from './http';
import {
  validateScheduleConfig,
  nextOccurrence,
  quietUntil,
  type CompanionScheduleConfig,
} from './companion-schedule-time';
const PATH = '/api/auth/companion-schedules';
const NOTIFICATIONS = '/api/auth/companion-notifications';
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const CONVERSATION = /^[A-Za-z0-9._:-]{1,128}$/;
const DAY = 86_400_000;
/** Unanswered outreach slows down per private relationship, capped at one week. */
function unansweredDelay(count: number): number {
  return Math.min(7 * DAY, DAY * 2 ** Math.min(Math.max(count - 1, 0), 3));
}
interface Row {
  user_id: string;
  id: string;
  relationship_id: string;
  conversation_id: string;
  config_json: string;
  version: number;
  next_run_at: number | null;
  occurrence_key: string | null;
  paused: number;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
const view = (row: Row) => ({
  id: row.id,
  relationshipId: row.relationship_id,
  conversationId: row.conversation_id,
  ...(JSON.parse(row.config_json) as CompanionScheduleConfig),
  version: row.version,
  paused: Boolean(row.paused),
  nextRunAt: row.next_run_at,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const bound = `JOIN character_relationships r ON r.user_id=s.user_id AND r.id=s.relationship_id AND r.deleted_at IS NULL
 JOIN server_conversations c ON c.user_id=s.user_id AND c.id=s.conversation_id AND c.deleted_at IS NULL AND json_extract(c.metadata,'$.relationshipId')=s.relationship_id
 JOIN users u ON u.id=s.user_id AND u.banned_at IS NULL
 WHERE NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=s.user_id)
 AND NOT EXISTS(SELECT 1 FROM companion_life_records l WHERE l.user_id=s.user_id AND l.relationship_id=s.relationship_id AND l.kind='lifecycle' AND l.label IN ('paused','ended') AND l.deleted_at IS NULL)`;
async function ownedBinding(
  env: GenerativeScheduleEnv,
  userId: string,
  relationshipId: string,
  conversationId: string,
) {
  return env.DB.prepare(
    `SELECT c.id FROM server_conversations c JOIN character_relationships r ON r.user_id=c.user_id AND r.id=? AND r.deleted_at IS NULL
 WHERE c.user_id=? AND c.id=? AND c.deleted_at IS NULL AND json_extract(c.metadata,'$.relationshipId')=r.id
 AND NOT EXISTS(SELECT 1 FROM companion_life_records l WHERE l.user_id=c.user_id AND l.relationship_id=r.id AND l.kind='lifecycle' AND l.label IN ('paused','ended') AND l.deleted_at IS NULL)`,
  )
    .bind(relationshipId, userId, conversationId)
    .first();
}
export async function handleCompanionSchedules(
  request: Request,
  env: GenerativeScheduleEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (
    path !== PATH &&
    !path.startsWith(`${PATH}/`) &&
    path !== NOTIFICATIONS &&
    !path.startsWith(`${NOTIFICATIONS}/`)
  )
    return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at != null) return err('账号不可用', 403, headers);
  const account = request.headers.get('X-Account-Id');
  if (account !== null && account !== user.id) return err('账号已切换', 403, headers);
  if (path === NOTIFICATIONS && request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT n.id,n.conversation_id AS conversationId,n.message_id AS messageId,n.created_at AS createdAt,n.read_at AS readAt
   FROM companion_notifications n JOIN server_conversations c ON c.user_id=n.user_id AND c.id=n.conversation_id AND c.deleted_at IS NULL
   WHERE n.user_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT 100`,
    )
      .bind(user.id)
      .all();
    return json({ items: rows.results }, 200, headers);
  }
  if (path.startsWith(`${NOTIFICATIONS}/`)) {
    let notificationPath: string;
    try {
      notificationPath = decodeURIComponent(path.slice(NOTIFICATIONS.length + 1));
    } catch {
      return err('通知编号无效', 400, headers);
    }
    const match = notificationPath.match(/^([A-Za-z0-9._:-]{1,128})\/read$/);
    if (!match || request.method !== 'PUT') return err('接口不存在', 404, headers);
    const found = await env.DB.prepare(
      'UPDATE companion_notifications SET read_at=COALESCE(read_at,?) WHERE user_id=? AND id=? RETURNING id',
    )
      .bind(Date.now(), user.id, match[1])
      .first();
    return found ? json({ ok: true }, 200, headers) : err('通知不存在', 404, headers);
  }
  if (path === PATH) {
    if (request.method !== 'GET') return err('不支持此操作', 405, headers);
    const relationshipId = url.searchParams.get('relationshipId');
    const rows = await env.DB.prepare(
      `SELECT * FROM companion_schedules WHERE user_id=? AND deleted_at IS NULL ${relationshipId ? 'AND relationship_id=?' : ''} ORDER BY created_at,id LIMIT 50`,
    )
      .bind(user.id, ...(relationshipId ? [relationshipId] : []))
      .all<Row>();
    return json(
      { items: rows.results.map(view), capability: proactiveCapability(env) },
      200,
      headers,
    );
  }
  const id = path.slice(PATH.length + 1);
  if (!ID.test(id)) return err('任务编号无效', 400, headers);
  if (!['PUT', 'DELETE'].includes(request.method)) return err('不支持此操作', 405, headers);
  const bytes = await readBodyBounded(request, 10_000);
  if (!bytes) return err('内容过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return err('请求格式错误', 400, headers);
  }
  const version = body.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0)
    return err('版本无效', 400, headers);
  const now = Date.now();
  if (request.method === 'DELETE') {
    if (Object.keys(body).some((key) => key !== 'version'))
      return err('包含不支持字段', 400, headers);
    const deleted = await env.DB.prepare(
      `UPDATE companion_schedules SET config_json='{}',paused=1,next_run_at=NULL,deleted_at=?,updated_at=?,version=version+1 WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL RETURNING id`,
    )
      .bind(now, now, user.id, id, version)
      .first();
    return deleted ? json({ ok: true }, 200, headers) : err('任务已变更或删除', 409, headers);
  }
  const allowed = [
    'version',
    'relationshipId',
    'conversationId',
    'kind',
    'localDate',
    'localTime',
    'timeZone',
    'weekdays',
    'quietStart',
    'quietEnd',
    'dailyLimit',
    'template',
    'paused',
    'mode',
    'acceptedCredits',
    'generationPriceVersion',
    'contextConsent',
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    return err('包含不支持字段', 400, headers);
  if (
    typeof body.relationshipId !== 'string' ||
    !ID.test(body.relationshipId) ||
    typeof body.conversationId !== 'string' ||
    !CONVERSATION.test(body.conversationId) ||
    typeof body.paused !== 'boolean'
  )
    return err('关系或会话无效', 400, headers);
  if (!(await ownedBinding(env, user.id, body.relationshipId, body.conversationId)))
    return err('请先将自己的角色关系绑定到当前会话', 400, headers);
  let config: CompanionScheduleConfig;
  let next: ReturnType<typeof nextOccurrence>;
  try {
    config = validateScheduleConfig(body);
    if (config.mode === 'model' && !body.paused) {
      const offer = proactiveCapability(env);
      if (
        !offer.enabled ||
        offer.credits !== config.acceptedCredits ||
        offer.priceVersion !== config.generationPriceVersion
      )
        throw new Error('主动AI服务未启用或价格已改变');
    }
    next = nextOccurrence(config, now);
    if (!body.paused && !next) throw new Error('该本地时间不存在或已经过去，请选择未来时间');
  } catch (error) {
    return err(error instanceof Error ? error.message : '配置无效', 400, headers);
  }
  const saved =
    version === 0
      ? await env.DB.prepare(
          `INSERT INTO companion_schedules(user_id,id,relationship_id,conversation_id,config_json,version,next_run_at,occurrence_key,paused,created_at,updated_at)
 SELECT ?,?,?,?,?,1,?,?,?,?,? WHERE (SELECT COUNT(*) FROM companion_schedules WHERE user_id=? AND deleted_at IS NULL)<50 ON CONFLICT(user_id,id) DO NOTHING RETURNING *`,
        )
          .bind(
            user.id,
            id,
            body.relationshipId,
            body.conversationId,
            JSON.stringify(config),
            body.paused ? null : (next?.at ?? null),
            next?.key ?? null,
            body.paused ? 1 : 0,
            now,
            now,
            user.id,
          )
          .first<Row>()
      : await env.DB.prepare(
          `UPDATE companion_schedules SET relationship_id=?,conversation_id=?,config_json=?,next_run_at=?,occurrence_key=?,paused=?,attempts=0,last_error=NULL,updated_at=?,version=version+1 WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL RETURNING *`,
        )
          .bind(
            body.relationshipId,
            body.conversationId,
            JSON.stringify(config),
            body.paused ? null : (next?.at ?? null),
            next?.key ?? null,
            body.paused ? 1 : 0,
            now,
            user.id,
            id,
            version,
          )
          .first<Row>();
  return saved
    ? json({ item: view(saved) }, version === 0 ? 201 : 200, headers)
    : err('任务已变更、删除或达到50条上限，请刷新', 409, headers);
}

/** Server cron only. Templates are free; model mode requires explicit credit/context consent. No device calls. */
export async function runCompanionSchedules(
  env: GenerativeScheduleEnv,
  now = Date.now(),
): Promise<void> {
  await cleanupGenerations(env, now);
  let modelCalls = 0;
  const due = await env.DB.prepare(
    'SELECT * FROM companion_schedules WHERE paused=0 AND deleted_at IS NULL AND next_run_at<=? ORDER BY next_run_at,user_id,id LIMIT 20',
  )
    .bind(now)
    .all<Row>();
  for (const row of due.results) {
    try {
      const valid = await env.DB.prepare(
        `SELECT s.id FROM companion_schedules s ${bound} AND s.user_id=? AND s.id=?`,
      )
        .bind(row.user_id, row.id)
        .first();
      if (!valid) {
        await env.DB.prepare(
          "UPDATE companion_schedules SET paused=1,next_run_at=NULL,last_error='关联会话、关系或账号不可用',version=version+1,updated_at=? WHERE user_id=? AND id=? AND version=?",
        )
          .bind(now, row.user_id, row.id, row.version)
          .run();
        continue;
      }
      const config = validateScheduleConfig(JSON.parse(row.config_json));
      const size = await env.DB.prepare(
        `SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(content AS BLOB))+length(id)+120),0) AS bytes FROM server_conversation_messages WHERE user_id=? AND conversation_id=?`,
      )
        .bind(row.user_id, row.conversation_id)
        .first<{ count: number; bytes: number }>();
      if (
        (size?.count ?? 0) >= 10_000 ||
        (size?.bytes ?? 0) + new TextEncoder().encode(config.template).length > 1_900_000
      ) {
        await env.DB.prepare(
          "UPDATE companion_schedules SET paused=1,next_run_at=NULL,last_error='会话记录已满，请选择新会话',version=version+1,updated_at=? WHERE user_id=? AND id=? AND version=?",
        )
          .bind(now, row.user_id, row.id, row.version)
          .run();
        continue;
      }
      const quiet = quietUntil(config, now);
      // A fixed reminder the user set up is delivered on time, limited only by its own
      // daily cap. The account-wide spacing and the "no reply yet" backoff exist to keep
      // AI-initiated (model) outreach from becoming pushy, so only those apply to it.
      const proactive = config.mode === 'model';
      const recent = await env.DB.prepare(
        'SELECT COUNT(*) AS count,MAX(created_at) AS latest FROM companion_deliveries WHERE user_id=? AND (?=1 OR schedule_id=?) AND created_at>?',
      )
        .bind(row.user_id, proactive ? 1 : 0, row.id, now - 86_400_000)
        .first<{ count: number; latest: number | null }>();
      const unanswered = await env.DB.prepare(
        `SELECT COUNT(*) AS count,MAX(d.created_at) AS latest
         FROM companion_deliveries d
         JOIN companion_schedules previous ON previous.user_id=d.user_id AND previous.id=d.schedule_id
         WHERE d.user_id=? AND previous.relationship_id=?
           AND d.created_at>COALESCE((
             SELECT MAX(m.created_at) FROM server_conversation_messages m
             JOIN server_conversations c ON c.user_id=m.user_id AND c.id=m.conversation_id
             WHERE m.user_id=? AND m.role='user' AND c.deleted_at IS NULL
               AND json_extract(c.metadata,'$.relationshipId')=?
           ),-1)`,
      )
        .bind(row.user_id, row.relationship_id, row.user_id, row.relationship_id)
        .first<{ count: number; latest: number | null }>();
      const unansweredUntil =
        proactive && unanswered?.latest != null && unanswered.count > 0
          ? unanswered.latest + unansweredDelay(unanswered.count)
          : null;
      const frequencyLimited =
        (recent?.count ?? 0) >= config.dailyLimit ||
        (proactive && recent?.latest != null && recent.latest > now - 30 * 60_000);
      if (
        quiet !== null ||
        frequencyLimited ||
        (unansweredUntil !== null && unansweredUntil > now)
      ) {
        const retry = Math.max(
          quiet ?? now,
          unansweredUntil ?? now,
          frequencyLimited ? now + 60 * 60_000 : now,
        );
        await env.DB.prepare(
          'UPDATE companion_schedules SET next_run_at=? WHERE user_id=? AND id=? AND version=? AND next_run_at=?',
        )
          .bind(retry, row.user_id, row.id, row.version, row.next_run_at)
          .run();
        continue;
      }
      if (config.mode === 'model' && modelCalls++ >= 2) {
        // Over this run's model budget: move it back a minute so it cannot hold the head
        // of the due list and starve fixed reminders queued behind it.
        await env.DB.prepare(
          'UPDATE companion_schedules SET next_run_at=? WHERE user_id=? AND id=? AND version=? AND next_run_at=?',
        )
          .bind(now + 60_000, row.user_id, row.id, row.version, row.next_run_at)
          .run();
        continue;
      }
      const generated =
        config.mode === 'model' ? await prepareGeneration(env, row, config, now) : null;
      if (config.mode === 'model' && !generated) continue;
      const deliveryTime = Math.max(now, Date.now());
      const quietAfterGeneration = quietUntil(config, deliveryTime);
      if (quietAfterGeneration !== null) {
        await env.DB.prepare(
          'UPDATE companion_schedules SET next_run_at=? WHERE user_id=? AND id=? AND version=?',
        )
          .bind(quietAfterGeneration, row.user_id, row.id, row.version)
          .run();
        continue;
      }
      const deliveryContent = generated
        ? `AI主动消息\n${generated.content}`
        : `定时消息\n${config.template}`;
      const generationGuard = generated
        ? `AND EXISTS(SELECT 1 FROM companion_generations g JOIN credit_reservations r ON r.idempotency_key=g.reservation_key WHERE g.user_id=s.user_id AND g.schedule_id=s.id AND g.occurrence_key=s.occurrence_key AND g.schedule_version=s.version AND g.state='ready' AND r.status='pending')`
        : '';
      const next = config.kind === 'weekly' ? nextOccurrence(config, now) : null;
      const token = crypto.randomUUID();
      const messageId = `scheduled:${row.id}:${row.occurrence_key}`;
      const claim = `EXISTS(SELECT 1 FROM companion_deliveries WHERE user_id=? AND schedule_id=? AND occurrence_key=? AND claim_token=?)`;
      const args = [row.user_id, row.id, row.occurrence_key, token];
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO companion_deliveries(user_id,schedule_id,occurrence_key,claim_token,message_id,created_at)
     SELECT s.user_id,s.id,s.occurrence_key,?,?,? FROM companion_schedules s ${bound}
     AND s.user_id=? AND s.id=? AND s.version=? AND s.next_run_at=? AND s.paused=0 AND s.deleted_at IS NULL ${generationGuard}
     AND (SELECT COUNT(*) FROM companion_deliveries WHERE user_id=s.user_id AND (?=1 OR schedule_id=s.id) AND created_at>?)<?
          AND (?=0 OR NOT EXISTS(SELECT 1 FROM companion_deliveries WHERE user_id=s.user_id AND created_at>?))
          AND (?=0 OR NOT EXISTS(
            SELECT 1 FROM companion_deliveries d
            JOIN companion_schedules previous ON previous.user_id=d.user_id AND previous.id=d.schedule_id
            WHERE d.user_id=s.user_id AND previous.relationship_id=s.relationship_id AND d.created_at>?
              AND NOT EXISTS(
                SELECT 1 FROM server_conversation_messages m
                JOIN server_conversations c ON c.user_id=m.user_id AND c.id=m.conversation_id
                WHERE m.user_id=s.user_id AND m.role='user' AND m.created_at>d.created_at
                  AND c.deleted_at IS NULL AND json_extract(c.metadata,'$.relationshipId')=s.relationship_id
              )
          ))
          AND (SELECT COUNT(*) FROM server_conversation_messages WHERE user_id=s.user_id AND conversation_id=s.conversation_id)<10000
          AND (SELECT COALESCE(SUM(length(CAST(content AS BLOB))+length(id)+120),0) FROM server_conversation_messages WHERE user_id=s.user_id AND conversation_id=s.conversation_id) + ? <= 1900000
     ON CONFLICT(user_id,schedule_id,occurrence_key) DO NOTHING`,
        ).bind(
          token,
          messageId,
          now,
          row.user_id,
          row.id,
          row.version,
          row.next_run_at,
          proactive ? 1 : 0,
          now - 86_400_000,
          config.dailyLimit,
          proactive ? 1 : 0,
          now - 30 * 60_000,
          proactive ? 1 : 0,
          now - DAY,
          new TextEncoder().encode(deliveryContent).length,
        ),
        env.DB.prepare(
          `INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position)
     SELECT ?,?,?,'assistant',?,?,COALESCE((SELECT MAX(position)+1 FROM server_conversation_messages WHERE user_id=? AND conversation_id=?),0)
     WHERE ${claim} ON CONFLICT(user_id,conversation_id,id) DO NOTHING`,
        ).bind(
          row.user_id,
          row.conversation_id,
          messageId,
          deliveryContent,
          now,
          row.user_id,
          row.conversation_id,
          ...args,
        ),
        env.DB.prepare(
          `UPDATE server_conversations SET revision=revision+1,updated_at=MAX(updated_at+1,?),mutation_id=? WHERE user_id=? AND id=? AND ${claim}`,
        ).bind(now, token, row.user_id, row.conversation_id, ...args),
        env.DB.prepare(
          `INSERT INTO companion_notifications(user_id,id,conversation_id,message_id,created_at) SELECT ?,?,?,?,? WHERE ${claim} ON CONFLICT(user_id,id) DO NOTHING`,
        ).bind(row.user_id, messageId, row.conversation_id, messageId, now, ...args),
        prepareAiPushDelivery(env, row.user_id, row.conversation_id, messageId, now),
        env.DB.prepare(
          `UPDATE companion_schedules SET next_run_at=?,occurrence_key=?,paused=?,attempts=0,last_error=NULL,updated_at=?,version=version+1 WHERE user_id=? AND id=? AND ${claim}`,
        ).bind(
          next?.at ?? null,
          next?.key ?? null,
          next ? 0 : 1,
          now,
          row.user_id,
          row.id,
          ...args,
        ),
        ...(generated ? generationSettlement(env, generated.reservation, claim, args, now) : []),
      ]);
    } catch {
      const attempts = Math.min(row.attempts + 1, 10);
      const delay = Math.min(3_600_000, 60_000 * 2 ** (attempts - 1));
      await env.DB.prepare(
        "UPDATE companion_schedules SET attempts=?,next_run_at=?,last_error='发送失败，等待重试' WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL",
      )
        .bind(attempts, now + delay, row.user_id, row.id, row.version)
        .run();
    }
  }
}
