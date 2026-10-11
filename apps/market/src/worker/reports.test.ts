/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { handleReports } from './reports';
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function setup() {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  const directory = join(import.meta.dirname, '../../migrations');
  for (const file of readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(join(directory, file), 'utf8'));
  sql.exec(
    `INSERT INTO items(id,type,name,content,created_at,hidden) VALUES ('card','scenario','角色','{"prompt":"人物设定","characterCard":{"schemaVersion":1}}',1,0),('old','waveform','波形','{}',1,0),('hidden','scenario','隐藏','{"prompt":"隐藏设定","characterCard":{"schemaVersion":1}}',1,1)`,
  );
  sql.exec(
    `INSERT INTO items(id,type,name,content,created_at,hidden) VALUES ('legacy','scenario','旧场景','{"prompt":"公开场景"}',1,0)`,
  );
  function prepare(query: string, args: unknown[] = []): unknown {
    return {
      bind: (...values: unknown[]) => prepare(query, values),
      first: async () => sql.prepare(query).get(...(args as never[])) ?? null,
      all: async () => ({ results: sql.prepare(query).all(...(args as never[])) }),
      run: async () => sql.prepare(query).run(...(args as never[])),
    };
  }
  let user: string | null = 'alice';
  let admin = false;
  const env = {
    DB: { prepare } as unknown as D1Database,
    AUTH: {
      marketAccountIdentity: async () => (user ? { id: user } : null),
      marketAccountAccess: async () => (admin ? ('admin' as const) : ('user' as const)),
    },
  };
  async function call(path: string, method = 'GET', body?: unknown, account = user ?? '') {
    return (await handleReports(
      new Request(`https://market.test/api/items/${path}`, {
        method,
        headers: { 'X-Account-Id': account },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    ))!;
  }
  return {
    sql,
    call,
    setUser: (value: string | null) => {
      user = value;
    },
    setAdmin: () => {
      admin = true;
    },
  };
}
it('requires matching account and accepts visible public prompt cards, including old scenes', async () => {
  const { call, setUser } = setup();
  setUser(null);
  expect((await call('card/report', 'PUT', { reason: 'spam' })).status).toBe(401);
  setUser('alice');
  expect((await call('card/report', 'PUT', { reason: 'spam' }, 'bob')).status).toBe(409);
  expect((await call('card/report', 'PUT', { reason: ['spam'] })).status).toBe(400);
  expect((await call('card/report', 'PUT', { reason: 'spam', reporter: 'bob' })).status).toBe(400);
  expect((await call('old/report', 'PUT', { reason: 'spam' })).status).toBe(404);
  expect((await call('hidden/report', 'PUT', { reason: 'spam' })).status).toBe(404);
  expect((await call('legacy/report', 'PUT', { reason: 'spam' })).status).toBe(200);
});
it('is idempotent per account and item; restricts all identities to an admin-only private queue', async () => {
  const { sql, call, setUser, setAdmin } = setup();
  expect((await call('card/report', 'PUT', { reason: 'privacy' })).status).toBe(200);
  expect((await call('card/report', 'PUT', { reason: 'spam' })).status).toBe(200);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM item_reports').get()?.n).toBe(1);
  expect((await call('admin/reports')).status).toBe(403);
  setUser('admin');
  setAdmin();
  const response = await call('admin/reports');
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  const body = await response.text();
  expect(body).toContain('privacy');
  expect(body).not.toContain('alice');
  expect(body).not.toContain('reporter');
});
it('atomically hides all pending reports, cannot re-hide restored content via stale report, and supports dismiss', async () => {
  const { sql, call, setUser, setAdmin } = setup();
  await call('card/report', 'PUT', { reason: 'spam' });
  setUser('bob');
  await call('card/report', 'PUT', { reason: 'privacy' });
  const id = String(sql.prepare('SELECT id FROM item_reports LIMIT 1').get()?.id);
  setAdmin();
  expect((await call(`admin/reports/${id}`, 'PATCH', { action: 'hide' })).status).toBe(200);
  expect(
    sql.prepare("SELECT COUNT(*) AS n FROM item_reports WHERE status='pending'").get()?.n,
  ).toBe(0);
  sql.exec("UPDATE items SET hidden=0 WHERE id='card'");
  await call(`admin/reports/${id}`, 'PATCH', { action: 'hide' });
  expect(sql.prepare("SELECT hidden FROM items WHERE id='card'").get()?.hidden).toBe(0);
  setUser('charlie');
  await call('card/report', 'PUT', { reason: 'copyright' });
  const pending = String(
    sql.prepare("SELECT id FROM item_reports WHERE status='pending'").get()?.id,
  );
  expect((await call(`admin/reports/${pending}`, 'PATCH', { action: 'dismiss' })).status).toBe(200);
  expect((await call(`admin/reports/${pending}`, 'PATCH', { action: 'hide' })).status).toBe(409);
});
it('legacy hide/delete paths close queues and daily rate limit is enforced atomically', async () => {
  const { sql, call, setUser } = setup();
  await call('card/report', 'PUT', { reason: 'spam' });
  sql.exec("UPDATE items SET hidden=1 WHERE id='card'");
  expect(sql.prepare('SELECT status FROM item_reports').get()?.status).toBe('hidden');
  sql.exec("UPDATE items SET hidden=0 WHERE id='card'");
  setUser('bob');
  await call('card/report', 'PUT', { reason: 'spam' });
  sql.exec("DELETE FROM items WHERE id='card'");
  expect(sql.prepare("SELECT status FROM item_reports WHERE reporter_id='bob'").get()?.status).toBe(
    'removed',
  );
  const content = JSON.stringify({ prompt: '公开人物', characterCard: { schemaVersion: 1 } });
  for (let i = 0; i < 11; i++) {
    sql
      .prepare("INSERT INTO items(id,type,name,content,created_at) VALUES (?,'scenario','n',?,1)")
      .run(`new${i}`, content);
  }
  setUser('rate');
  for (let i = 0; i < 10; i++)
    expect((await call(`new${i}/report`, 'PUT', { reason: 'spam' })).status).toBe(200);
  expect((await call('new10/report', 'PUT', { reason: 'spam' })).status).toBe(429);
  expect((await call('new0/report', 'PUT', { reason: 'spam' })).status).toBe(200);
});
