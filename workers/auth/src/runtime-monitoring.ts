import {
  CLIENT_ERROR_LIMITS,
  clientErrorSignatureSource,
  parseClientErrorReport,
  parseServerErrorReport,
  topStackFrame,
} from '@0xnullai/observability';
import { err, json, readBodyBounded } from './http';
import { currentUser, sha256Hex } from './session-domain';

/**
 * Runtime monitoring: anonymous client error intake, per-Worker server error counts, the
 * admin 运行状况 view, threshold alerts and retention. See migrations/0072.
 *
 * The intake never reads the session: reports are stored without an account, IP or session id,
 * and the only per-sender state is the peppered IP hash in a one-hour rate-limit ledger.
 */

export interface MonitoringEnv {
  DB: D1Database;
  EMAIL?: SendEmail;
  /** Comma-separated admin addresses. Unset: no alert email is sent. */
  ALERT_EMAIL?: string;
  ALERT_CLIENT_ERRORS_PER_HOUR?: string;
  ALERT_SERVER_ERRORS_PER_HOUR?: string;
  ALERT_NEW_SIGNATURE_HITS?: string;
  ALERT_COOLDOWN_HOURS?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const INTAKE_WINDOW_MS = 10 * 60 * 1000;
/** Generous because carrier-grade NAT puts many phones behind one address in mainland China. */
export const MAX_CLIENT_REPORTS_PER_IP = 60;
/** Bounds D1 writes from a distributed flood; real reports beyond this are already an incident. */
export const MAX_CLIENT_REPORTS_PER_HOUR = 5000;
export const MONITORING_RETENTION_MS = 30 * DAY_MS;
const NEW_SIGNATURE_WINDOW_MS = DAY_MS;

export const ALERT_DEFAULTS = {
  clientErrorsPerHour: 100,
  serverErrorsPerHour: 20,
  newSignatureHits: 20,
  cooldownHours: 6,
} as const;

const hourStart = (at: number) => Math.floor(at / HOUR_MS) * HOUR_MS;

function positiveSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function alertSettings(env: MonitoringEnv) {
  return {
    clientErrorsPerHour: positiveSetting(
      env.ALERT_CLIENT_ERRORS_PER_HOUR,
      ALERT_DEFAULTS.clientErrorsPerHour,
    ),
    serverErrorsPerHour: positiveSetting(
      env.ALERT_SERVER_ERRORS_PER_HOUR,
      ALERT_DEFAULTS.serverErrorsPerHour,
    ),
    newSignatureHits: positiveSetting(
      env.ALERT_NEW_SIGNATURE_HITS,
      ALERT_DEFAULTS.newSignatureHits,
    ),
    cooldownMs: positiveSetting(env.ALERT_COOLDOWN_HOURS, ALERT_DEFAULTS.cooldownHours) * HOUR_MS,
  };
}

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export function alertRecipients(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((address) => address.trim().toLowerCase())
        .filter((address) => address.length <= 254 && EMAIL.test(address)),
    ),
  ].slice(0, 10);
}

async function clientErrorSignature(message: string, stack: string | null): Promise<string> {
  return (await sha256Hex(clientErrorSignatureSource(message, stack))).slice(0, 32);
}

async function acceptClientError(
  request: Request,
  env: MonitoringEnv,
  cors: Record<string, string>,
  ipHash: string,
  now: number,
): Promise<Response> {
  const body = await readBodyBounded(request, CLIENT_ERROR_LIMITS.bodyBytes);
  if (!body) return err('报告过大', 413, cors);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return err('报告格式无效', 400, cors);
  }
  const report = parseClientErrorReport(value);
  if (!report) return err('报告格式无效', 400, cors);

  const [mine, everyone] = await Promise.all([
    env.DB.prepare(
      'SELECT COUNT(*) AS n FROM client_error_intake WHERE ip_hash = ? AND created_at >= ?',
    )
      .bind(ipHash, now - INTAKE_WINDOW_MS)
      .first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM client_error_intake WHERE created_at >= ?')
      .bind(now - HOUR_MS)
      .first<{ n: number }>(),
  ]);
  if (
    (mine?.n ?? 0) >= MAX_CLIENT_REPORTS_PER_IP ||
    (everyone?.n ?? 0) >= MAX_CLIENT_REPORTS_PER_HOUR
  )
    return err('报告过于频繁', 429, cors);

  const signature = await clientErrorSignature(report.message, report.stack);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO client_error_intake (ip_hash, created_at) VALUES (?, ?)').bind(
      ipHash,
      now,
    ),
    // Server time decides the bucket: client clocks are untrusted and often wrong.
    env.DB.prepare(
      `INSERT INTO client_error_hourly
         (signature, hour_start, count, kind, message, top_frame, stack, module_id, platform,
          product_version, build_id, route, first_seen_at, last_seen_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (signature, hour_start) DO UPDATE SET
         count = count + 1,
         kind = excluded.kind,
         stack = excluded.stack,
         module_id = excluded.module_id,
         platform = excluded.platform,
         product_version = excluded.product_version,
         build_id = excluded.build_id,
         route = excluded.route,
         last_seen_at = excluded.last_seen_at`,
    ).bind(
      signature,
      hourStart(now),
      report.kind,
      report.message,
      topStackFrame(report.stack),
      report.stack,
      report.moduleId,
      report.platform,
      report.version,
      report.buildId,
      report.route,
      now,
      now,
    ),
  ]);
  return json({ ok: true }, 202, cors);
}

/** Record a Worker's coalesced error counts; malformed input is ignored. */
export async function recordServerErrors(
  env: MonitoringEnv,
  value: unknown,
  now = Date.now(),
): Promise<boolean> {
  const report = parseServerErrorReport(value);
  if (!report) return false;
  await env.DB.batch(
    report.counts.map(({ kind, count }) =>
      env.DB.prepare(
        `INSERT INTO server_error_hourly (worker, hour_start, kind, count, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (worker, hour_start, kind) DO UPDATE SET
           count = count + excluded.count,
           last_seen_at = excluded.last_seen_at`,
      ).bind(report.worker, hourStart(now), kind, count, now),
    ),
  );
  return true;
}

export interface RuntimeHealth {
  generatedAt: number;
  since: number;
  server: Array<{
    worker: string;
    http5xx: number;
    exceptions: number;
    scheduled: number;
    lastSeenAt: number;
  }>;
  clientTotal: number;
  signatures: Array<{
    signature: string;
    kind: string;
    message: string;
    topFrame: string | null;
    moduleId: string | null;
    platform: string;
    version: string;
    count: number;
    firstSeenAt: number;
    lastSeenAt: number;
  }>;
}

export async function runtimeHealth(env: MonitoringEnv, now = Date.now()): Promise<RuntimeHealth> {
  const since = hourStart(now - DAY_MS) + HOUR_MS;
  const [server, total, signatures] = await Promise.all([
    env.DB.prepare(
      `SELECT worker, kind, SUM(count) AS count, MAX(last_seen_at) AS last_seen_at
         FROM server_error_hourly WHERE hour_start >= ? GROUP BY worker, kind`,
    )
      .bind(since)
      .all<{ worker: string; kind: string; count: number; last_seen_at: number }>(),
    env.DB.prepare(
      'SELECT COALESCE(SUM(count), 0) AS n FROM client_error_hourly WHERE hour_start >= ?',
    )
      .bind(since)
      .first<{ n: number }>(),
    // Bare columns next to MAX() take the most recent row's sample (SQLite semantics, as D1).
    env.DB.prepare(
      `SELECT signature, SUM(count) AS count, MAX(last_seen_at) AS last_seen_at,
              MIN(first_seen_at) AS first_seen_at, kind, message, top_frame, module_id, platform,
              product_version
         FROM client_error_hourly WHERE hour_start >= ?
        GROUP BY signature ORDER BY count DESC, last_seen_at DESC LIMIT 20`,
    )
      .bind(since)
      .all<Record<string, unknown>>(),
  ]);
  const workers = new Map<string, RuntimeHealth['server'][number]>();
  for (const row of server.results ?? []) {
    const entry = workers.get(row.worker) ?? {
      worker: row.worker,
      http5xx: 0,
      exceptions: 0,
      scheduled: 0,
      lastSeenAt: 0,
    };
    const count = Number(row.count);
    if (row.kind === 'http_5xx') entry.http5xx += count;
    else if (row.kind === 'exception') entry.exceptions += count;
    else entry.scheduled += count;
    entry.lastSeenAt = Math.max(entry.lastSeenAt, Number(row.last_seen_at));
    workers.set(row.worker, entry);
  }
  return {
    generatedAt: now,
    since,
    server: [...workers.values()].sort((a, b) => a.worker.localeCompare(b.worker)),
    clientTotal: Number(total?.n ?? 0),
    signatures: (signatures.results ?? []).map((row) => ({
      signature: String(row.signature),
      kind: String(row.kind),
      message: String(row.message),
      topFrame: row.top_frame == null ? null : String(row.top_frame),
      moduleId: row.module_id == null ? null : String(row.module_id),
      platform: String(row.platform),
      version: String(row.product_version),
      count: Number(row.count),
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
    })),
  };
}

/** Routes: anonymous `POST /api/auth/client-errors`, admin `GET /api/auth/admin/runtime-health`. */
export async function handleRuntimeMonitoring(
  request: Request,
  env: MonitoringEnv,
  cors: Record<string, string>,
  ipHash: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === '/api/auth/client-errors') {
    if (request.method !== 'POST') return err('不支持此操作', 405, cors);
    return acceptClientError(request, env, cors, ipHash, Date.now());
  }
  if (path === '/api/auth/admin/runtime-health') {
    const headers = { ...cors, 'Cache-Control': 'no-store' };
    if (request.method !== 'GET') return err('不支持此操作', 405, headers);
    const user = await currentUser(request, env);
    if (!user || user.role !== 'admin') return err('无管理权限', 403, headers);
    return json(await runtimeHealth(env), 200, headers);
  }
  return null;
}

async function recentlyAlerted(env: MonitoringEnv, key: string, after: number): Promise<boolean> {
  const row = await env.DB.prepare('SELECT last_sent_at FROM monitoring_alerts WHERE alert_key = ?')
    .bind(key)
    .first<{ last_sent_at: number }>();
  return row != null && row.last_sent_at > after;
}

export interface AlertOutcome {
  sent: boolean;
  keys: string[];
}

/**
 * Check the current and previous UTC hour against the thresholds and send at most one email.
 * Volume alerts repeat at most once per cooldown; a new signature alerts once.
 */
export async function runMonitoringAlerts(env: MonitoringEnv, now: number): Promise<AlertOutcome> {
  const recipients = alertRecipients(env.ALERT_EMAIL);
  if (!env.EMAIL || recipients.length === 0) return { sent: false, keys: [] };
  const settings = alertSettings(env);
  const windowStart = hourStart(now) - HOUR_MS;
  const lines: string[] = [];
  const subjects: string[] = [];
  const keys: string[] = [];

  const client = await env.DB.prepare(
    `SELECT hour_start, SUM(count) AS n FROM client_error_hourly WHERE hour_start >= ?
      GROUP BY hour_start ORDER BY n DESC LIMIT 1`,
  )
    .bind(windowStart)
    .first<{ hour_start: number; n: number }>();
  if (
    client &&
    client.n >= settings.clientErrorsPerHour &&
    !(await recentlyAlerted(env, 'client-volume', now - settings.cooldownMs))
  ) {
    keys.push('client-volume');
    subjects.push(`客户端错误 ${client.n}/小时`);
    lines.push(
      `客户端错误：${new Date(client.hour_start).toISOString().slice(0, 13)}:00 UTC 起一小时内 ${client.n} 次（阈值 ${settings.clientErrorsPerHour}）。`,
    );
  }

  const server = await env.DB.prepare(
    `SELECT hour_start, SUM(count) AS n FROM server_error_hourly WHERE hour_start >= ?
      GROUP BY hour_start ORDER BY n DESC LIMIT 1`,
  )
    .bind(windowStart)
    .first<{ hour_start: number; n: number }>();
  if (
    server &&
    server.n >= settings.serverErrorsPerHour &&
    !(await recentlyAlerted(env, 'server-errors', now - settings.cooldownMs))
  ) {
    const breakdown = await env.DB.prepare(
      `SELECT worker, kind, count FROM server_error_hourly WHERE hour_start = ?
        ORDER BY count DESC LIMIT 15`,
    )
      .bind(server.hour_start)
      .all<{ worker: string; kind: string; count: number }>();
    keys.push('server-errors');
    subjects.push(`服务端错误 ${server.n}/小时`);
    lines.push(
      `服务端错误：${new Date(server.hour_start).toISOString().slice(0, 13)}:00 UTC 起一小时内 ${server.n} 次（阈值 ${settings.serverErrorsPerHour}）。`,
      ...(breakdown.results ?? []).map((row) => `  - ${row.worker} ${row.kind}: ${row.count}`),
    );
  }

  const fresh = await env.DB.prepare(
    `SELECT h.signature, SUM(h.count) AS hits, MAX(h.last_seen_at) AS last_seen_at, h.message,
            h.module_id, h.platform, h.product_version
       FROM client_error_hourly h
      WHERE h.hour_start >= ?
      GROUP BY h.signature
     HAVING hits >= ?
        AND (SELECT MIN(f.first_seen_at) FROM client_error_hourly f WHERE f.signature = h.signature) >= ?
        AND NOT EXISTS (SELECT 1 FROM monitoring_alerts a WHERE a.alert_key = 'signature:' || h.signature)
      ORDER BY hits DESC LIMIT 5`,
  )
    .bind(windowStart, settings.newSignatureHits, now - NEW_SIGNATURE_WINDOW_MS)
    .all<{
      signature: string;
      hits: number;
      message: string;
      module_id: string | null;
      platform: string;
      product_version: string;
    }>();
  const signatures = fresh.results ?? [];
  if (signatures.length) {
    subjects.push(`${signatures.length} 个新错误`);
    lines.push(
      `新出现的客户端错误（24 小时内首次出现，近两小时 ≥ ${settings.newSignatureHits} 次）：`,
    );
    for (const row of signatures) {
      keys.push(`signature:${row.signature}`);
      lines.push(
        `  - ${row.hits} 次 · ${row.module_id ?? '外壳'} · ${row.platform} ${row.product_version} · ${row.message.slice(0, 160)}`,
      );
    }
  }

  if (keys.length === 0) return { sent: false, keys };
  try {
    await env.EMAIL.send({
      to: recipients,
      from: { email: 'no-reply@0xnullai.com', name: '猫愿监控' },
      subject: `猫愿运行告警：${subjects.join('，')}`,
      text: `${lines.join('\n')}\n\n详情：设置 → 管理 → 运行状况。同类告警 ${settings.cooldownMs / HOUR_MS} 小时内不重复发送。`,
    });
  } catch (error) {
    // Not recorded as sent, so the next run retries.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'monitoring_alert_email_failed',
        error: String(error),
      }),
    );
    return { sent: false, keys };
  }
  await env.DB.batch(
    keys.map((key) =>
      env.DB.prepare(
        `INSERT INTO monitoring_alerts (alert_key, last_sent_at) VALUES (?, ?)
         ON CONFLICT (alert_key) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
      ).bind(key, now),
    ),
  );
  return { sent: true, keys };
}

/** Every-five-minutes work: prune the rate-limit ledger, then check alerts. */
export async function runRuntimeMonitoring(env: MonitoringEnv, now: number): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM client_error_intake WHERE created_at < ?')
      .bind(now - HOUR_MS)
      .run();
    await runMonitoringAlerts(env, now);
  } catch (error) {
    console.error(
      JSON.stringify({ level: 'error', event: 'runtime_monitoring_failed', error: String(error) }),
    );
  }
}

/** Daily retention: aggregates and alert markers older than 30 days. */
export function monitoringRetentionStatements(
  env: MonitoringEnv,
  now: number,
): D1PreparedStatement[] {
  const cutoff = now - MONITORING_RETENTION_MS;
  return [
    env.DB.prepare('DELETE FROM client_error_hourly WHERE hour_start < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM server_error_hourly WHERE hour_start < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM monitoring_alerts WHERE last_sent_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM client_error_intake WHERE created_at < ?').bind(now - HOUR_MS),
  ];
}
