import { err, json, readBodyBounded } from './http';
import { currentUser, sha256Hex, type SessionEnv } from './session-domain';

const BASE = '/api/auth/agent-runs';
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const TOOL_NAME = /^[A-Za-z0-9_:-]{1,100}$/;
const TOKEN = /^[a-f0-9-]{36}$/;
const RECEIPT_STATUS = new Set(['succeeded', 'denied', 'failed', 'pending', 'unknown']);
const FINISH_STATUS = new Set(['completed', 'incomplete', 'needs_review', 'failed', 'cancelled']);
const STALE_MS = 30 * 60_000;

interface RunRow {
  id: string;
  conversation_id: string;
  request_id: string;
  status: string;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}
interface CallRow {
  call_id: string;
  name: string;
  status: string;
  created_at: number;
  updated_at: number;
}
const RUN_COLUMNS = 'id,conversation_id,request_id,status,created_at,updated_at,finished_at';
const CALL_COLUMNS = 'call_id,name,status,created_at,updated_at';
const runView = (row: RunRow) => ({
  id: row.id,
  conversationId: row.conversation_id,
  requestId: row.request_id,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at,
  provenance: 'client-reported' as const,
});
const callView = (row: CallRow) => ({
  callId: row.call_id,
  name: row.name,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  provenance: 'client-reported' as const,
});
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  const bytes = await readBodyBounded(request, 4096);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return object(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function exact(
  body: Record<string, unknown> | null,
  keys: string[],
): body is Record<string, unknown> {
  return (
    body !== null &&
    Object.keys(body).length === keys.length &&
    keys.every((key) => Object.hasOwn(body, key))
  );
}

/** Client reports are durable audit hints; they never authorize device actions or prove side effects. */
export async function handleAgentRuns(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at != null) return err('账号不可用', 403, headers);
  if (request.headers.get('X-Account-Id') !== user.id)
    return err('账号已切换，请重新打开会话', 403, headers);

  const parts = url.pathname.slice(BASE.length).split('/').filter(Boolean);
  if (parts.length > 4 || parts.some((part) => !ID.test(part)))
    return err('任务编号无效', 400, headers);
  const [runId, action, callId, tail] = parts;
  if (url.pathname === BASE && request.method === 'POST') {
    const body = await bodyOf(request);
    if (
      !exact(body, ['conversationId', 'requestId']) ||
      typeof body.conversationId !== 'string' ||
      !ID.test(body.conversationId) ||
      typeof body.requestId !== 'string' ||
      !REQUEST_ID.test(body.requestId)
    )
      return err('会话或请求编号无效', 400, headers);
    const conversationId = body.conversationId;
    const requestId = body.requestId;
    const conversation = await env.DB.prepare(
      'SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL',
    )
      .bind(user.id, conversationId)
      .first();
    if (!conversation) return err('会话不存在或已删除', 404, headers);
    const existing = await env.DB.prepare(
      `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE user_id=? AND conversation_id=? AND request_id=?`,
    )
      .bind(user.id, conversationId, requestId)
      .first<RunRow>();
    if (existing) return json({ item: runView(existing), claimed: false }, 200, headers);
    const now = Date.now();
    const id = `run-${crypto.randomUUID()}`;
    const ownerToken = crypto.randomUUID();
    const ownerHash = await sha256Hex(ownerToken);
    const created = await env.DB.prepare(
      `INSERT INTO agent_runs(user_id,id,conversation_id,request_id,owner_hash,status,created_at,updated_at)
       SELECT ?,?,?,?,?,'active',?,? WHERE
       EXISTS(SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL)
       AND (SELECT COUNT(*) FROM agent_runs WHERE user_id=? AND created_at>=?)<500
       AND (SELECT COUNT(*) FROM agent_runs WHERE user_id=? AND status='active')<20
       AND NOT EXISTS(SELECT 1 FROM agent_runs WHERE user_id=? AND conversation_id=? AND status='active')
       ON CONFLICT DO NOTHING RETURNING ${RUN_COLUMNS}`,
    )
      .bind(
        user.id,
        id,
        conversationId,
        requestId,
        ownerHash,
        now,
        now,
        user.id,
        conversationId,
        user.id,
        now - 24 * 60 * 60_000,
        user.id,
        user.id,
        conversationId,
      )
      .first<RunRow>();
    if (created) return json({ item: runView(created), claimed: true, ownerToken }, 201, headers);
    const raced = await env.DB.prepare(
      `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE user_id=? AND conversation_id=? AND request_id=?`,
    )
      .bind(user.id, conversationId, requestId)
      .first<RunRow>();
    return raced
      ? json({ item: runView(raced), claimed: false }, 200, headers)
      : err('此会话仍有进行中的任务；请核对任务状态后再发送', 409, headers);
  }
  const conversationId = url.searchParams.get('conversationId');
  if (!conversationId || !ID.test(conversationId)) return err('必须指定当前会话', 400, headers);
  const conversation = await env.DB.prepare(
    'SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL',
  )
    .bind(user.id, conversationId)
    .first();
  if (!conversation) return err('会话不存在或已删除', 404, headers);
  if (!runId) {
    if (request.method !== 'GET') return err('不支持此操作', 405, headers);
    const rows = await env.DB.prepare(
      `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE user_id=? AND conversation_id=?
       ORDER BY created_at DESC,id ASC LIMIT 50`,
    )
      .bind(user.id, conversationId)
      .all<RunRow>();
    return json({ items: rows.results.map(runView) }, 200, headers);
  }
  const run = await env.DB.prepare(
    `SELECT ${RUN_COLUMNS},owner_hash FROM agent_runs WHERE user_id=? AND id=? AND conversation_id=?`,
  )
    .bind(user.id, runId, conversationId)
    .first<RunRow & { owner_hash: string | null }>();
  if (!run) return err('任务不存在', 404, headers);
  if (!action && request.method === 'GET') {
    const calls = await env.DB.prepare(
      `SELECT ${CALL_COLUMNS} FROM agent_run_calls WHERE user_id=? AND run_id=? ORDER BY created_at,call_id`,
    )
      .bind(user.id, runId)
      .all<CallRow>();
    return json({ item: runView(run), calls: calls.results.map(callView) }, 200, headers);
  }
  if (request.method !== 'PUT') return err('不支持此操作', 405, headers);
  if (action === 'calls' && callId && !tail) {
    const body = await bodyOf(request);
    if (
      !exact(body, ['name', 'ownerToken']) ||
      typeof body.name !== 'string' ||
      !TOOL_NAME.test(body.name) ||
      typeof body.ownerToken !== 'string' ||
      !TOKEN.test(body.ownerToken)
    )
      return err('工具名称无效', 400, headers);
    const ownerHash = await sha256Hex(body.ownerToken);
    if (!run.owner_hash || ownerHash !== run.owner_hash)
      return err('当前窗口没有此任务的执行权', 403, headers);
    const now = Date.now();
    const claimToken = crypto.randomUUID();
    const claimHash = await sha256Hex(claimToken);
    const claimed = await env.DB.prepare(
      `INSERT INTO agent_run_calls(user_id,run_id,call_id,name,status,claim_hash,created_at,updated_at)
       SELECT ?,?,?,?,'claimed',?,?,? WHERE
       EXISTS(SELECT 1 FROM agent_runs WHERE user_id=? AND id=? AND conversation_id=? AND owner_hash=? AND status='active')
       AND (SELECT COUNT(*) FROM agent_run_calls WHERE user_id=? AND run_id=?)<100
       ON CONFLICT DO NOTHING RETURNING ${CALL_COLUMNS}`,
    )
      .bind(
        user.id,
        runId,
        callId,
        body.name,
        claimHash,
        now,
        now,
        user.id,
        runId,
        conversationId,
        ownerHash,
        user.id,
        runId,
      )
      .first<CallRow>();
    if (!claimed) return err('工具调用已被领取、任务已结束或达到上限', 409, headers);
    await env.DB.prepare(
      "UPDATE agent_runs SET updated_at=? WHERE user_id=? AND id=? AND status='active'",
    )
      .bind(now, user.id, runId)
      .run();
    return json({ item: callView(claimed), claimToken }, 201, headers);
  }
  if (action === 'calls' && callId && tail === 'receipt') {
    const body = await bodyOf(request);
    if (
      !exact(body, ['claimToken', 'status']) ||
      typeof body.claimToken !== 'string' ||
      !TOKEN.test(body.claimToken) ||
      typeof body.status !== 'string' ||
      !RECEIPT_STATUS.has(body.status)
    )
      return err('工具结果无效', 400, headers);
    const hash = await sha256Hex(body.claimToken);
    const now = Date.now();
    const updated = await env.DB.prepare(
      `UPDATE agent_run_calls SET status=?,updated_at=? WHERE user_id=? AND run_id=? AND call_id=?
       AND claim_hash=? AND (status='claimed' OR (status='pending' AND ?<>'pending'))
       AND EXISTS(SELECT 1 FROM agent_runs WHERE user_id=? AND id=? AND conversation_id=? AND status='active')
       RETURNING ${CALL_COLUMNS}`,
    )
      // A tool that first reported "pending" later records its final outcome.
      .bind(
        body.status,
        now,
        user.id,
        runId,
        callId,
        hash,
        body.status,
        user.id,
        runId,
        conversationId,
      )
      .first<CallRow>();
    if (updated) {
      await env.DB.prepare(
        "UPDATE agent_runs SET updated_at=? WHERE user_id=? AND id=? AND status='active'",
      )
        .bind(now, user.id, runId)
        .run();
      return json({ item: callView(updated) }, 200, headers);
    }
    const previous = await env.DB.prepare(
      `SELECT ${CALL_COLUMNS},claim_hash FROM agent_run_calls WHERE user_id=? AND run_id=? AND call_id=?`,
    )
      .bind(user.id, runId, callId)
      .first<CallRow & { claim_hash: string }>();
    return previous?.claim_hash === hash && previous.status === body.status
      ? json({ item: callView(previous) }, 200, headers)
      : err('工具结果已变更或任务已结束', 409, headers);
  }
  if (action === 'finish' && !callId && !tail) {
    const body = await bodyOf(request);
    if (
      !exact(body, ['status', 'ownerToken']) ||
      typeof body.status !== 'string' ||
      !FINISH_STATUS.has(body.status) ||
      typeof body.ownerToken !== 'string' ||
      !TOKEN.test(body.ownerToken)
    )
      return err('任务状态无效', 400, headers);
    const ownerHash = await sha256Hex(body.ownerToken);
    if (!run.owner_hash || ownerHash !== run.owner_hash)
      return err('当前窗口没有此任务的执行权', 403, headers);
    const now = Date.now();
    const updated = await env.DB.prepare(
      `UPDATE agent_runs SET status=CASE
         WHEN EXISTS(SELECT 1 FROM agent_run_calls WHERE user_id=? AND run_id=? AND status IN ('claimed','pending','unknown')) THEN 'needs_review'
         WHEN ?='completed' AND EXISTS(SELECT 1 FROM agent_run_calls WHERE user_id=? AND run_id=? AND status IN ('denied','failed')) THEN 'incomplete'
         ELSE ? END,
       updated_at=?,finished_at=? WHERE user_id=? AND id=? AND conversation_id=? AND owner_hash=? AND status='active'
       RETURNING ${RUN_COLUMNS}`,
    )
      .bind(
        user.id,
        runId,
        body.status,
        user.id,
        runId,
        body.status,
        now,
        now,
        user.id,
        runId,
        conversationId,
        ownerHash,
      )
      .first<RunRow>();
    if (updated) return json({ item: runView(updated) }, 200, headers);
    if (body.status === 'needs_review') {
      const downgraded = await env.DB.prepare(
        `UPDATE agent_runs SET status='needs_review',updated_at=?
         WHERE user_id=? AND id=? AND conversation_id=? AND owner_hash=? AND status IN ('completed','incomplete','failed','cancelled')
         RETURNING ${RUN_COLUMNS}`,
      )
        .bind(now, user.id, runId, conversationId, ownerHash)
        .first<RunRow>();
      if (downgraded) return json({ item: runView(downgraded) }, 200, headers);
    }
    const previous = await env.DB.prepare(
      `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE user_id=? AND id=? AND conversation_id=?`,
    )
      .bind(user.id, runId, conversationId)
      .first<RunRow>();
    return previous?.status === body.status
      ? json({ item: runView(previous) }, 200, headers)
      : err('任务已结束或状态已变更', 409, headers);
  }
  return err('不支持此操作', 405, headers);
}

/** A lost browser may have performed a side effect. Never automatically replay its claimed call. */
export async function runAgentRunMaintenance(env: Pick<SessionEnv, 'DB'>, now = Date.now()) {
  const cutoff = now - STALE_MS;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE agent_run_calls SET status='unknown',updated_at=? WHERE status IN ('claimed','pending')
       AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.user_id=agent_run_calls.user_id
         AND r.id=agent_run_calls.run_id AND r.status='active' AND r.updated_at<?)`,
    ).bind(now, cutoff),
    env.DB.prepare(
      `UPDATE agent_runs SET status='needs_review',updated_at=?,finished_at=?
       WHERE status='active' AND updated_at<?`,
    ).bind(now, now, cutoff),
  ]);
}
