import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleAgentRuns, runAgentRunMaintenance } from './agent-runs';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;

beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  for (const user of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,1)',
    )
      .bind(user, user, user, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)',
    )
      .bind(await sha256Hex(user), user, Date.now() + 60_000)
      .run();
    await env.DB.prepare(
      "INSERT INTO server_conversations(user_id,id,created_at,updated_at,mutation_id) VALUES(?,'one',1,1,'m')",
    )
      .bind(user)
      .run();
  }
});
afterEach(() => db.close());

async function call(
  path: string,
  method = 'GET',
  body?: object,
  token = 'alice',
  account = token,
): Promise<Response> {
  const response = await handleAgentRuns(
    new Request(`https://0xnullai.com/api/auth/agent-runs${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'X-Account-Id': account },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    {},
  );
  if (!response) throw new Error('route not handled');
  return response;
}

async function start(requestId = 'request-0001') {
  const response = await call('', 'POST', { conversationId: 'one', requestId });
  expect(response.status).toBe(201);
  return (await response.json()) as { item: { id: string }; claimed: boolean; ownerToken: string };
}

it('creates a server run once per request and guards account and conversation ownership', async () => {
  const first = await start();
  expect(first.claimed).toBe(true);
  expect(first.item.id).toMatch(/^run-/);
  expect(first.ownerToken).toMatch(/^[a-f0-9-]{36}$/);
  const repeat = await call('', 'POST', { conversationId: 'one', requestId: 'request-0001' });
  expect(repeat.status).toBe(200);
  expect(await repeat.json()).toMatchObject({ item: { id: first.item.id }, claimed: false });
  expect((await call(`/${first.item.id}?conversationId=one`, 'GET', undefined, 'bob')).status).toBe(
    404,
  );
  expect(
    (await call('', 'POST', { conversationId: 'one', requestId: 'request-0002' }, 'alice', 'bob'))
      .status,
  ).toBe(403);
  expect(
    (await call('', 'POST', { conversationId: 'missing', requestId: 'request-0002' })).status,
  ).toBe(404);
  expect((await call(`/${first.item.id}?conversationId=one`)).headers.get('cache-control')).toBe(
    'no-store',
  );
});

it('prevents a second live run in the same conversation after a window reload', async () => {
  const first = await start();
  const competing = await call('', 'POST', {
    conversationId: 'one',
    requestId: 'request-another-window',
  });
  expect(competing.status).toBe(409);
  expect(await competing.json()).toMatchObject({ error: expect.stringContaining('进行中的任务') });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM agent_runs WHERE user_id='alice' AND conversation_id='one'",
    ).first<{ count: number }>(),
  ).toMatchObject({ count: 1 });

  const claimed = await call(`/${first.item.id}/calls/call-1?conversationId=one`, 'PUT', {
    name: 'shock_start',
    ownerToken: first.ownerToken,
  });
  expect(claimed.status).toBe(201);
  const { claimToken } = (await claimed.json()) as { claimToken: string };
  expect(
    (
      await call(`/${first.item.id}/calls/call-1/receipt?conversationId=one`, 'PUT', {
        claimToken,
        status: 'unknown',
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await call(`/${first.item.id}/finish?conversationId=one`, 'PUT', {
        status: 'completed',
        ownerToken: first.ownerToken,
      })
    ).json(),
  ).toMatchObject({ item: { status: 'needs_review' } });
  expect(
    (
      await call('', 'POST', {
        conversationId: 'one',
        requestId: 'request-after-review',
      })
    ).status,
  ).toBe(201);
});

it('grants one claim for a call and records only the matching result token', async () => {
  const { item, ownerToken } = await start();
  const path = `/${item.id}/calls/call-1?conversationId=one`;
  const claim = await call(path, 'PUT', { name: 'web_search', ownerToken });
  expect(claim.status).toBe(201);
  const { claimToken } = (await claim.json()) as { claimToken: string };
  expect((await call(path, 'PUT', { name: 'web_search', ownerToken })).status).toBe(409);
  expect(
    (
      await call(`/${item.id}/calls/call-1/receipt?conversationId=one`, 'PUT', {
        claimToken: crypto.randomUUID(),
        status: 'succeeded',
      })
    ).status,
  ).toBe(409);
  const receiptPath = `/${item.id}/calls/call-1/receipt?conversationId=one`;
  expect((await call(receiptPath, 'PUT', { claimToken, status: 'succeeded' })).status).toBe(200);
  expect((await call(receiptPath, 'PUT', { claimToken, status: 'succeeded' })).status).toBe(200);
  expect((await call(receiptPath, 'PUT', { claimToken, status: 'failed' })).status).toBe(409);
  expect(await (await call(`/${item.id}?conversationId=one`)).json()).toMatchObject({
    item: { status: 'active', provenance: 'client-reported' },
    calls: [{ callId: 'call-1', status: 'succeeded', provenance: 'client-reported' }],
  });
});

it('records the final outcome of a tool that first reported pending, once', async () => {
  const { item, ownerToken } = await start();
  const claim = await call(`/${item.id}/calls/call-1?conversationId=one`, 'PUT', {
    name: 'web_search',
    ownerToken,
  });
  const { claimToken } = (await claim.json()) as { claimToken: string };
  const receiptPath = `/${item.id}/calls/call-1/receipt?conversationId=one`;
  expect((await call(receiptPath, 'PUT', { claimToken, status: 'pending' })).status).toBe(200);
  expect((await call(receiptPath, 'PUT', { claimToken, status: 'pending' })).status).toBe(200);
  expect((await call(receiptPath, 'PUT', { claimToken, status: 'succeeded' })).status).toBe(200);
  expect((await call(receiptPath, 'PUT', { claimToken, status: 'failed' })).status).toBe(409);
});
it('lets another window inspect a run but never append a different call or finish it', async () => {
  const { item, ownerToken } = await start();
  const replay = await call('', 'POST', { conversationId: 'one', requestId: 'request-0001' });
  expect(await replay.json()).toMatchObject({ claimed: false });
  expect((await call(`/${item.id}?conversationId=one`)).status).toBe(200);
  const differentCall = `/${item.id}/calls/other-window-call?conversationId=one`;
  expect((await call(differentCall, 'PUT', { name: 'web_search' })).status).toBe(400);
  expect(
    (await call(differentCall, 'PUT', { name: 'web_search', ownerToken: crypto.randomUUID() }))
      .status,
  ).toBe(403);
  expect(
    (
      await call(`/${item.id}/finish?conversationId=one`, 'PUT', {
        status: 'completed',
        ownerToken: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
  expect((await call(differentCall, 'PUT', { name: 'web_search', ownerToken })).status).toBe(201);
});

it('does not mark unreported or failed tools as successfully complete', async () => {
  const { item, ownerToken } = await start();
  const path = `/${item.id}/calls/call-1?conversationId=one`;
  expect((await call(path, 'PUT', { name: 'device_action', ownerToken })).status).toBe(201);
  const finish = await call(`/${item.id}/finish?conversationId=one`, 'PUT', {
    status: 'completed',
    ownerToken,
  });
  expect(await finish.json()).toMatchObject({ item: { status: 'needs_review' } });
  expect((await call(path, 'PUT', { name: 'device_action', ownerToken })).status).toBe(409);
  expect(
    (
      await call(`/${item.id}/finish?conversationId=one`, 'PUT', {
        status: 'completed',
        ownerToken,
      })
    ).status,
  ).toBe(409);

  const second = await start('request-0002');
  const claim = await call(`/${second.item.id}/calls/call-2?conversationId=one`, 'PUT', {
    name: 'web_search',
    ownerToken: second.ownerToken,
  });
  const { claimToken } = (await claim.json()) as { claimToken: string };
  await call(`/${second.item.id}/calls/call-2/receipt?conversationId=one`, 'PUT', {
    claimToken,
    status: 'failed',
  });
  expect(
    await (
      await call(`/${second.item.id}/finish?conversationId=one`, 'PUT', {
        status: 'completed',
        ownerToken: second.ownerToken,
      })
    ).json(),
  ).toMatchObject({ item: { status: 'incomplete' } });
});

it('marks stale claimed calls for review and removes runs when a conversation is deleted', async () => {
  const { item, ownerToken } = await start();
  await call(`/${item.id}/calls/call-1?conversationId=one`, 'PUT', {
    name: 'web_search',
    ownerToken,
  });
  const now = Date.now();
  await env.DB.prepare('UPDATE agent_runs SET updated_at=? WHERE user_id=? AND id=?')
    .bind(now - 31 * 60_000, 'alice', item.id)
    .run();
  await runAgentRunMaintenance(env, now);
  expect(await (await call(`/${item.id}?conversationId=one`)).json()).toMatchObject({
    item: { status: 'needs_review' },
    calls: [{ status: 'unknown' }],
  });
  await env.DB.prepare(
    "UPDATE server_conversations SET deleted_at=5 WHERE user_id='alice' AND id='one'",
  ).run();
  expect((await call(`/${item.id}?conversationId=one`)).status).toBe(404);
  expect(
    await env.DB.prepare('SELECT id FROM agent_runs WHERE user_id=? AND id=?')
      .bind('alice', item.id)
      .first(),
  ).toBeNull();
});

it('uses a rolling creation limit so long-lived conversations do not lock permanently', async () => {
  const old = Date.now() - 2 * 24 * 60 * 60_000;
  await env.DB.prepare(
    `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<500)
     INSERT INTO agent_runs(user_id,id,conversation_id,request_id,status,created_at,updated_at,finished_at)
     SELECT 'alice','old-'||n,'one','old-request-'||n,'completed',?,?,? FROM seq`,
  )
    .bind(old, old, old)
    .run();
  expect(
    (
      await call('', 'POST', {
        conversationId: 'one',
        requestId: 'request-after-history',
      })
    ).status,
  ).toBe(201);
  await env.DB.prepare('UPDATE agent_runs SET created_at=? WHERE user_id=?')
    .bind(Date.now(), 'alice')
    .run();
  expect(
    (
      await call('', 'POST', {
        conversationId: 'one',
        requestId: 'request-over-daily-limit',
      })
    ).status,
  ).toBe(409);
});

it('can conservatively reopen a completed client report when delivering the reply fails', async () => {
  const { item, ownerToken } = await start();
  const path = `/${item.id}/finish?conversationId=one`;
  expect(await (await call(path, 'PUT', { status: 'completed', ownerToken })).json()).toMatchObject(
    {
      item: { status: 'completed' },
    },
  );
  expect(
    await (await call(path, 'PUT', { status: 'needs_review', ownerToken })).json(),
  ).toMatchObject({
    item: { status: 'needs_review' },
  });
  expect((await call(path, 'PUT', { status: 'completed', ownerToken })).status).toBe(409);
});
