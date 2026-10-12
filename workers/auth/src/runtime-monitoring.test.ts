import { describe, expect, it } from 'vitest';
import worker, { AuthMonitoringService } from './index';
import {
  env,
  prepared,
  req,
  seedUser,
  sentEmails,
  useAuthWorkerTestEnv,
} from './index.test-support';
import { createTestDb } from './test-helpers';
import {
  MAX_CLIENT_REPORTS_PER_IP,
  MONITORING_RETENTION_MS,
  alertRecipients,
  monitoringRetentionStatements,
  recordServerErrors,
  runMonitoringAlerts,
  runtimeHealth,
} from './runtime-monitoring';

useAuthWorkerTestEnv(createTestDb);

const HOUR = 60 * 60 * 1000;

function report(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'error',
    message: 'TypeError: cannot read x',
    stack:
      'TypeError: cannot read x\n    at render (https://0xnullai.com/assets/index-AbC12345.js?v=2:1:100)',
    moduleId: 'agent',
    platform: 'android',
    version: '7.0.0',
    buildId: 'abc123',
    route: '/u/alice?tab=photos',
    occurredAt: Date.now(),
    sessionId: 'session-0001',
    ...overrides,
  };
}

const postReport = (body: unknown, ip = '1.2.3.4', token?: string) =>
  worker.fetch(
    req('/api/auth/client-errors', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ip,
      token,
    }),
    env,
  );

async function rows(sql: string, ...args: unknown[]) {
  return (await prepared(sql, ...args).all<Record<string, unknown>>()).results;
}

describe('client error intake', () => {
  it('aggregates identical errors by signature without storing identity', async () => {
    const { token } = await seedUser('alice');
    expect((await postReport(report(), '1.2.3.4', token)).status).toBe(202);
    // A new build with different chunk hashes and columns is still the same error.
    const again = report({
      stack:
        'TypeError: cannot read x\n    at render (https://0xnullai.com/assets/index-ZzZ98765.js:1:999)',
    });
    expect((await postReport(again)).status).toBe(202);
    const stored = await rows('SELECT * FROM client_error_hourly');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      count: 2,
      route: '/u/:param',
      top_frame: 'render /assets/index.js',
      platform: 'android',
    });
    const dump = JSON.stringify(stored);
    for (const forbidden of ['id-alice', 'alice', 'session-0001', '1.2.3.4', '?v=2'])
      expect(dump).not.toContain(forbidden);
  });

  it('validates method, size and shape', async () => {
    expect((await worker.fetch(req('/api/auth/client-errors'), env)).status).toBe(405);
    expect((await postReport('{not json')).status).toBe(400);
    expect((await postReport(report({ platform: 'ios' }))).status).toBe(400);
    expect((await postReport(report({ message: 'x'.repeat(20_000) }))).status).toBe(413);
    expect(await rows('SELECT * FROM client_error_hourly')).toHaveLength(0);
  });

  it('rate-limits per IP hash', async () => {
    for (let i = 0; i < MAX_CLIENT_REPORTS_PER_IP; i++)
      expect(
        (await postReport(report({ message: `error ${'abcdefghij'[i % 10]}${i}` }))).status,
      ).toBe(202);
    expect((await postReport(report())).status).toBe(429);
    expect((await postReport(report(), '5.6.7.8')).status).toBe(202);
  });
});

describe('server error counts', () => {
  it('accumulates valid reports and ignores malformed ones', async () => {
    const now = Date.now();
    expect(
      await recordServerErrors(
        env,
        { worker: 'chat', counts: [{ kind: 'http_5xx', count: 3 }] },
        now,
      ),
    ).toBe(true);
    expect(
      await recordServerErrors(
        env,
        { worker: 'chat', counts: [{ kind: 'http_5xx', count: 2 }] },
        now,
      ),
    ).toBe(true);
    expect(await recordServerErrors(env, { worker: 'evil', counts: [] }, now)).toBe(false);
    expect(await rows('SELECT worker, kind, count FROM server_error_hourly')).toEqual([
      { worker: 'chat', kind: 'http_5xx', count: 5 },
    ]);
  });

  it('exposes only the counter on the Chat entrypoint', async () => {
    const service = new AuthMonitoringService({} as never, env);
    (service as unknown as { env: typeof env }).env = env;
    await service.recordServerErrors({ worker: 'chat', counts: [{ kind: 'exception', count: 1 }] });
    expect(await rows('SELECT kind FROM server_error_hourly')).toEqual([{ kind: 'exception' }]);
  });

  it('counts Auth 5xx responses through the fail-open wrapper', async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as never;
    const db = env.DB;
    // Break only the feedback table so the route answers 500 while D1 still records the count.
    const flaky = {
      ...env,
      DB: new Proxy(db, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              if (sql.includes('FROM feedback')) throw new Error('d1 down');
              return target.prepare(sql);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    } as typeof env;
    const failed = await worker.fetch(
      req('/api/auth/feedback', { method: 'POST', body: JSON.stringify({ message: 'hi' }) }),
      flaky,
      ctx,
    );
    expect(failed.status).toBe(500);
    // A 404 is not an error.
    expect((await worker.fetch(req('/api/auth/nope'), env, ctx)).status).toBe(404);
    while (pending.length) await Promise.all(pending.splice(0));
    expect(await rows('SELECT worker, kind, count FROM server_error_hourly')).toEqual([
      { worker: 'auth', kind: 'http_5xx', count: 1 },
    ]);
  });
});

describe('admin runtime health', () => {
  it('is admin-only and summarizes the last 24 hours', async () => {
    const admin = await seedUser('root');
    const user = await seedUser('bob');
    await prepared("UPDATE users SET role = 'admin' WHERE id = ?", admin.id).run();
    await postReport(report());
    await recordServerErrors(env, { worker: 'market', counts: [{ kind: 'http_5xx', count: 4 }] });
    await recordServerErrors(env, { worker: 'market', counts: [{ kind: 'scheduled', count: 1 }] });
    await prepared(
      `INSERT INTO server_error_hourly (worker, hour_start, kind, count, last_seen_at)
       VALUES ('voice', ?, 'http_5xx', 99, 1)`,
      Date.now() - 3 * 24 * HOUR,
    ).run();

    const denied = await worker.fetch(
      req('/api/auth/admin/runtime-health', { token: user.token }),
      env,
    );
    expect(denied.status).toBe(403);
    const res = await worker.fetch(
      req('/api/auth/admin/runtime-health', { token: admin.token }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Awaited<ReturnType<typeof runtimeHealth>>;
    expect(body.server).toEqual([
      expect.objectContaining({ worker: 'market', http5xx: 4, scheduled: 1, exceptions: 0 }),
    ]);
    expect(body.clientTotal).toBe(1);
    expect(body.signatures[0]).toMatchObject({ count: 1, moduleId: 'agent', platform: 'android' });
  });
});

describe('retention', () => {
  it('deletes aggregates and alert markers older than 30 days and intake older than an hour', async () => {
    const now = Date.now();
    const old = now - MONITORING_RETENTION_MS - HOUR;
    await prepared(
      `INSERT INTO client_error_hourly
         (signature, hour_start, count, kind, message, platform, product_version, build_id, route,
          first_seen_at, last_seen_at)
       VALUES ('old', ?, 1, 'error', 'm', 'web', '1', 'b', '/', ?, ?),
              ('new', ?, 1, 'error', 'm', 'web', '1', 'b', '/', ?, ?)`,
      old,
      old,
      old,
      now,
      now,
      now,
    ).run();
    await prepared(
      `INSERT INTO server_error_hourly (worker, hour_start, kind, count, last_seen_at)
       VALUES ('auth', ?, 'http_5xx', 1, ?), ('auth', ?, 'http_5xx', 1, ?)`,
      old,
      old,
      now,
      now,
    ).run();
    await prepared(
      "INSERT INTO monitoring_alerts VALUES ('client-volume', ?), ('server-errors', ?)",
      old,
      now,
    ).run();
    await prepared(
      "INSERT INTO client_error_intake VALUES ('h', ?), ('h', ?)",
      now - 2 * HOUR,
      now,
    ).run();
    await env.DB.batch(monitoringRetentionStatements(env, now));
    expect(await rows('SELECT signature FROM client_error_hourly')).toEqual([{ signature: 'new' }]);
    expect(await rows('SELECT hour_start FROM server_error_hourly')).toEqual([{ hour_start: now }]);
    expect(await rows('SELECT alert_key FROM monitoring_alerts')).toEqual([
      { alert_key: 'server-errors' },
    ]);
    expect(await rows('SELECT created_at FROM client_error_intake')).toEqual([{ created_at: now }]);
  });
});

describe('alerts', () => {
  const alertEnv = () => ({ ...env, ALERT_EMAIL: 'ops@example.com, bad-address, OPS@example.com' });

  async function seedClientErrors(signature: string, count: number, at: number, firstSeen = at) {
    await prepared(
      `INSERT INTO client_error_hourly
         (signature, hour_start, count, kind, message, platform, product_version, build_id, route,
          first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 'error', ?, 'web', '7.0.0', 'b', '/', ?, ?)`,
      signature,
      Math.floor(at / HOUR) * HOUR,
      count,
      `Error ${signature}`,
      firstSeen,
      at,
    ).run();
  }

  it('parses and de-duplicates recipients', () => {
    expect(alertRecipients(' a@x.io,B@x.io, a@x.io ,nope')).toEqual(['a@x.io', 'b@x.io']);
    expect(alertRecipients(undefined)).toEqual([]);
  });

  it('does nothing without ALERT_EMAIL or below thresholds', async () => {
    const now = Date.now();
    await seedClientErrors('s', 1000, now);
    expect(await runMonitoringAlerts(env, now)).toEqual({ sent: false, keys: [] });
    await prepared('DELETE FROM client_error_hourly').run();
    await seedClientErrors('s', 5, now);
    expect((await runMonitoringAlerts(alertEnv(), now)).sent).toBe(false);
    expect(sentEmails).toHaveLength(0);
  });

  it('sends one combined email, then respects the cooldown and alerts a signature once', async () => {
    const now = Date.now();
    await seedClientErrors('old-sig', 150, now, now - 7 * 24 * HOUR);
    await seedClientErrors('fresh-sig', 30, now);
    await recordServerErrors(
      env,
      { worker: 'llm-proxy', counts: [{ kind: 'http_5xx', count: 25 }] },
      now,
    );

    const first = await runMonitoringAlerts(alertEnv(), now);
    expect(first.sent).toBe(true);
    expect(first.keys.sort()).toEqual(['client-volume', 'server-errors', 'signature:fresh-sig']);
    expect(sentEmails).toHaveLength(1);
    const email = sentEmails[0] as { to: string[]; subject: string; text: string };
    expect(email.to).toEqual(['ops@example.com']);
    expect(email.subject).toContain('客户端错误 180/小时');
    expect(email.text).toContain('llm-proxy http_5xx: 25');
    expect(email.text).toContain('Error fresh-sig');
    expect(email.text).not.toContain('Error old-sig\n');

    // Inside the cooldown nothing is re-sent.
    expect((await runMonitoringAlerts(alertEnv(), now + HOUR)).sent).toBe(false);
    // After the cooldown the volume alerts may repeat, the signature never does.
    const later = now + 7 * HOUR;
    await seedClientErrors('old-sig', 200, later, now - 7 * 24 * HOUR);
    await seedClientErrors('fresh-sig', 50, later, now);
    const second = await runMonitoringAlerts(alertEnv(), later);
    expect(second.keys).toEqual(['client-volume']);
    expect(sentEmails).toHaveLength(2);
  });

  it('retries when the email fails', async () => {
    const now = Date.now();
    await seedClientErrors('s', 500, now);
    const failing = {
      ...alertEnv(),
      EMAIL: {
        send: async () => {
          throw new Error('smtp down');
        },
      } as unknown as SendEmail,
    };
    expect((await runMonitoringAlerts(failing, now)).sent).toBe(false);
    expect(await rows('SELECT * FROM monitoring_alerts')).toHaveLength(0);
    expect((await runMonitoringAlerts(alertEnv(), now)).sent).toBe(true);
  });
});
