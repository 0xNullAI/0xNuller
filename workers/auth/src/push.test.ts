import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex } from './session-domain';
import {
  enqueueChatPush,
  handlePushRegistrations,
  prepareAiPushDelivery,
  runPushDeliveries,
  type PushEnv,
} from './push';

const now = Date.parse('2027-01-01T00:00:00Z');
const fid = 'firebase-installation-01';
let testDb: ReturnType<typeof createTestDb>;
let env: PushEnv;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  testDb = createTestDb();
  env = {
    DB: testDb.DB as D1Database,
    CHAT: { fetch: async () => Response.json({ eligible: true }) } as unknown as Fetcher,
  };
  for (const id of ['alice', 'bob', 'outsider']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,1)',
    )
      .bind(id, id, id, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)',
    )
      .bind(await sha256Hex(id), id, now + 86_400_000)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO user_follows(follower_id,followee_id,created_at) VALUES('alice','bob',1),('bob','alice',1)",
  ).run();
});
afterEach(() => {
  testDb.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function request(
  account: string,
  method: string,
  installationId = fid,
  options: { installationKey?: string; previousInstallationId?: string } = {},
) {
  return new Request(
    `https://test/api/auth/push/registrations${method === 'DELETE' ? `/${installationId}` : ''}`,
    {
      method,
      headers: { Authorization: `Bearer ${account}`, 'X-Account-Id': account },
      ...(method === 'PUT'
        ? {
            body: JSON.stringify({
              provider: 'fcm-fid',
              installationId,
              platform: 'android',
              ...options,
            }),
          }
        : Object.keys(options).length > 0
          ? { body: JSON.stringify(options) }
          : {}),
    },
  );
}
const rows = () => env.DB.prepare('SELECT * FROM push_deliveries').all();

it('replaces refreshed FIDs for one stable installation without consuming another device slot', async () => {
  const installationKey = 'stable-installation-key-001';
  const registered = (account: string) =>
    env.DB.prepare(
      'SELECT installation_id,user_id,installation_key FROM push_registrations WHERE user_id=?',
    )
      .bind(account)
      .all();
  expect(
    (await handlePushRegistrations(request('alice', 'PUT', fid, { installationKey }), env, {}))!
      .status,
  ).toBe(200);
  await enqueueChatPush(env, {
    kind: 'dm',
    targetId: 'bob',
    eventId: 'before-rotation',
    senderAccountId: 'bob',
    recipientAccountIds: ['alice'],
  });
  expect((await rows()).results).toHaveLength(1);
  const nextFid = 'firebase-installation-02';
  expect(
    (await handlePushRegistrations(request('alice', 'PUT', nextFid, { installationKey }), env, {}))!
      .status,
  ).toBe(200);
  expect((await registered('alice')).results).toEqual([
    { installation_id: nextFid, user_id: 'alice', installation_key: installationKey },
  ]);
  expect((await rows()).results).toHaveLength(0);
  for (let index = 0; index < 9; index += 1) {
    expect(
      (await handlePushRegistrations(
        request('alice', 'PUT', `other-installation-${String(index).padStart(2, '0')}`),
        env,
        {},
      ))!.status,
    ).toBe(200);
  }
  expect((await registered('alice')).results).toHaveLength(10);
  expect(
    (await handlePushRegistrations(
      request('alice', 'PUT', 'firebase-installation-03', { installationKey }),
      env,
      {},
    ))!.status,
  ).toBe(200);
  expect((await registered('alice')).results).toHaveLength(10);
  expect(
    (await handlePushRegistrations(request('alice', 'PUT', 'extra-installation-01'), env, {}))!
      .status,
  ).toBe(409);
});

it('enforces the installation cap when two registrations race after their initial counts', async () => {
  for (let index = 0; index < 9; index += 1) {
    const id = `existing-installation-${String(index).padStart(2, '0')}`;
    expect((await handlePushRegistrations(request('alice', 'PUT', id), env, {}))!.status).toBe(200);
  }
  // Hold both preflight reads until each has observed nine devices. Without
  // the INSERT-side guard both requests then return 200 and create 11 rows.
  const originalDb = env.DB;
  let countReads = 0;
  let releaseCounts!: () => void;
  const bothCountsRead = new Promise<void>((resolve) => {
    releaseCounts = resolve;
  });
  env.DB = {
    ...originalDb,
    prepare(sql: string) {
      if (sql !== 'SELECT COUNT(*) AS n FROM push_registrations WHERE user_id=?')
        return originalDb.prepare(sql);
      return {
        bind(...args: unknown[]) {
          const bound = originalDb.prepare(sql).bind(...args);
          return {
            async first<T>() {
              const result = await bound.first<T>();
              countReads += 1;
              if (countReads === 2) releaseCounts();
              await bothCountsRead;
              return result;
            },
          };
        },
      } as unknown as D1PreparedStatement;
    },
  } as D1Database;
  const results = await Promise.all([
    handlePushRegistrations(request('alice', 'PUT', 'racing-installation-01'), env, {}),
    handlePushRegistrations(request('alice', 'PUT', 'racing-installation-02'), env, {}),
  ]);
  expect(countReads).toBe(2);
  expect(results.map((response) => response!.status).sort()).toEqual([200, 409]);
  expect(
    (
      await env.DB.prepare('SELECT installation_id FROM push_registrations WHERE user_id=?')
        .bind('alice')
        .all()
    ).results,
  ).toHaveLength(10);
});

it('does not steal another account FID or clear its deliveries when the late cap rejects transfer', async () => {
  const sharedFid = 'bob-owned-installation-01';
  expect((await handlePushRegistrations(request('bob', 'PUT', sharedFid), env, {}))!.status).toBe(
    200,
  );
  await enqueueChatPush(env, {
    kind: 'dm',
    targetId: 'alice',
    eventId: 'bob-pending-event',
    senderAccountId: 'alice',
    recipientAccountIds: ['bob'],
  });
  for (let index = 0; index < 9; index += 1) {
    const id = `alice-installation-${String(index).padStart(2, '0')}`;
    await handlePushRegistrations(request('alice', 'PUT', id), env, {});
  }
  const originalDb = env.DB;
  env.DB = {
    ...originalDb,
    prepare(sql: string) {
      if (sql !== 'SELECT COUNT(*) AS n FROM push_registrations WHERE user_id=?')
        return originalDb.prepare(sql);
      return {
        bind(...args: unknown[]) {
          const bound = originalDb.prepare(sql).bind(...args);
          return {
            async first<T>() {
              const snapshot = await bound.first<T>();
              await originalDb
                .prepare(
                  `INSERT INTO push_registrations(installation_id,user_id,provider,platform,created_at,updated_at)
                 VALUES(?,?,'fcm-fid','android',?,?)`,
                )
                .bind('alice-tenth-installation', 'alice', now, now)
                .run();
              return snapshot;
            },
          };
        },
      } as unknown as D1PreparedStatement;
    },
  } as D1Database;
  expect((await handlePushRegistrations(request('alice', 'PUT', sharedFid), env, {}))!.status).toBe(
    409,
  );
  expect(
    await env.DB.prepare('SELECT user_id FROM push_registrations WHERE installation_id=?')
      .bind(sharedFid)
      .first(),
  ).toEqual({ user_id: 'bob' });
  expect((await rows()).results).toHaveLength(1);
});

it('replaces a legacy FID after first rotation and cannot remove another account registration', async () => {
  const oldFid = 'firebase-installation-old';
  const otherFid = 'firebase-installation-bob';
  await handlePushRegistrations(request('alice', 'PUT', oldFid), env, {});
  await handlePushRegistrations(
    request('bob', 'PUT', otherFid, {
      installationKey: 'stable-installation-key-bob',
    }),
    env,
    {},
  );
  const response = await handlePushRegistrations(
    request('alice', 'PUT', fid, {
      installationKey: 'stable-installation-key-alice',
      previousInstallationId: oldFid,
    }),
    env,
    {},
  );
  expect(response!.status).toBe(200);
  expect(
    await env.DB.prepare('SELECT 1 FROM push_registrations WHERE installation_id=?')
      .bind(oldFid)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare('SELECT user_id FROM push_registrations WHERE installation_id=?')
      .bind(otherFid)
      .first(),
  ).toEqual({ user_id: 'bob' });
  // Even a forged previous FID is scoped to the authenticated account.
  await handlePushRegistrations(
    request('alice', 'PUT', 'firebase-installation-03', {
      installationKey: 'stable-installation-key-alice',
      previousInstallationId: otherFid,
    }),
    env,
    {},
  );
  expect(
    await env.DB.prepare('SELECT user_id FROM push_registrations WHERE installation_id=?')
      .bind(otherFid)
      .first(),
  ).toEqual({ user_id: 'bob' });
  // An old client refreshing the same FID must not erase the key.
  await handlePushRegistrations(request('alice', 'PUT', 'firebase-installation-03'), env, {});
  expect(
    await env.DB.prepare('SELECT installation_key FROM push_registrations WHERE installation_id=?')
      .bind('firebase-installation-03')
      .first(),
  ).toEqual({ installation_key: 'stable-installation-key-alice' });
});

it('scopes a claimed installation key to the authenticated account', async () => {
  const sharedKey = 'same-claimed-installation-key';
  await handlePushRegistrations(
    request('alice', 'PUT', fid, {
      installationKey: sharedKey,
    }),
    env,
    {},
  );
  await handlePushRegistrations(
    request('bob', 'PUT', 'firebase-installation-bob', {
      installationKey: sharedKey,
      previousInstallationId: fid,
    }),
    env,
    {},
  );
  const registered = await env.DB.prepare(
    'SELECT installation_id,user_id FROM push_registrations WHERE installation_key=? ORDER BY user_id',
  )
    .bind(sharedKey)
    .all();
  expect(registered.results).toEqual([
    { installation_id: fid, user_id: 'alice' },
    { installation_id: 'firebase-installation-bob', user_id: 'bob' },
  ]);
});

it('revokes current and rotated destinations atomically within the authenticated account', async () => {
  const key = 'stable-installation-key-001';
  const oldFid = 'firebase-installation-old';
  const currentFid = 'firebase-installation-new';
  const bobFid = 'firebase-installation-bob';
  await handlePushRegistrations(request('alice', 'PUT', oldFid), env, {});
  await handlePushRegistrations(
    request('alice', 'PUT', currentFid, { installationKey: key }),
    env,
    {},
  );
  await handlePushRegistrations(request('bob', 'PUT', bobFid, { installationKey: key }), env, {});
  expect(
    (await handlePushRegistrations(
      request('alice', 'DELETE', currentFid, {
        installationKey: key,
        previousInstallationId: oldFid,
      }),
      env,
      {},
    ))!.status,
  ).toBe(200);
  const registrations = await env.DB.prepare(
    'SELECT installation_id,user_id FROM push_registrations ORDER BY user_id',
  ).all();
  expect(registrations.results).toEqual([{ installation_id: bobFid, user_id: 'bob' }]);
});

it('requires Bearer auth and safely transfers one FID between accounts', async () => {
  const cookieOnly = request('alice', 'PUT');
  cookieOnly.headers.delete('Authorization');
  expect((await handlePushRegistrations(cookieOnly, env, {}))!.status).toBe(401);
  expect((await handlePushRegistrations(request('alice', 'PUT'), env, {}))!.status).toBe(200);
  await enqueueChatPush(env, {
    kind: 'dm',
    targetId: 'bob',
    eventId: 'first',
    senderAccountId: 'bob',
    recipientAccountIds: ['alice'],
  });
  expect((await rows()).results).toHaveLength(1);
  expect((await handlePushRegistrations(request('bob', 'PUT'), env, {}))!.status).toBe(200);
  expect((await rows()).results).toHaveLength(0);
  expect(
    await env.DB.prepare('SELECT user_id FROM push_registrations WHERE installation_id=?')
      .bind(fid)
      .first(),
  ).toEqual({ user_id: 'bob' });
  await enqueueChatPush(env, {
    kind: 'group',
    targetId: 'room',
    eventId: 'second',
    senderAccountId: 'alice',
    recipientAccountIds: ['alice', 'bob', 'bob'],
  });
  expect((await rows()).results).toHaveLength(1);
  expect((await handlePushRegistrations(request('alice', 'DELETE'), env, {}))!.status).toBe(200);
  expect((await rows()).results).toHaveLength(1);
  expect((await handlePushRegistrations(request('bob', 'DELETE'), env, {}))!.status).toBe(200);
  expect((await rows()).results).toHaveLength(0);
});

async function fcmSecret() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const bytes = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  const pem = btoa(String.fromCharCode(...bytes))
    .match(/.{1,64}/g)!
    .join('\n');
  return JSON.stringify({
    project_id: 'project-test',
    client_email: 'push@test.invalid',
    private_key: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`,
  });
}

it('sends only data via FCM fid and deduplicates the same event', async () => {
  await handlePushRegistrations(request('alice', 'PUT'), env, {});
  const event = {
    kind: 'dm' as const,
    targetId: 'bob',
    eventId: 'event-1',
    senderAccountId: 'bob',
    recipientAccountIds: ['alice'],
  };
  await enqueueChatPush(env, event);
  await enqueueChatPush(env, event);
  expect((await rows()).results).toHaveLength(1);
  env.FCM_SERVICE_ACCOUNT_JSON = await fcmSecret();
  const sent: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('oauth2.googleapis.com'))
        return Response.json({ access_token: 'test-access', expires_in: 3600 });
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ name: 'projects/project-test/messages/1' });
    }),
  );
  await runPushDeliveries(env, now);
  expect(sent).toEqual([
    {
      message: {
        fid,
        data: { kind: 'dm', targetId: 'bob', eventId: 'event-1', accountId: 'alice' },
        android: { priority: 'high', ttl: '86400s' },
      },
    },
  ]);
  await runPushDeliveries(env, now + 60_000);
  expect(sent).toHaveLength(1);
});

it('retries ordinary failures and removes an FID only for confirmed UNREGISTERED', async () => {
  await handlePushRegistrations(request('alice', 'PUT'), env, {});
  await enqueueChatPush(env, {
    kind: 'group',
    targetId: 'group',
    eventId: 'event-1',
    senderAccountId: 'bob',
    recipientAccountIds: ['alice'],
  });
  env.FCM_SERVICE_ACCOUNT_JSON = await fcmSecret();
  let sends = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('oauth2.googleapis.com'))
        return Response.json({ access_token: 'test-access', expires_in: 3600 });
      sends++;
      return sends === 1
        ? Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 })
        : Response.json({ error: { status: 'UNREGISTERED' } }, { status: 404 });
    }),
  );
  await runPushDeliveries(env, now);
  expect((await rows()).results).toHaveLength(1);
  expect(
    await env.DB.prepare('SELECT installation_id FROM push_registrations').first(),
  ).toBeTruthy();
  await runPushDeliveries(env, now + 60_000);
  expect((await rows()).results).toHaveLength(0);
  expect(await env.DB.prepare('SELECT installation_id FROM push_registrations').first()).toBeNull();
});

it('rechecks group membership and DM blocks before any FCM send', async () => {
  await handlePushRegistrations(request('alice', 'PUT'), env, {});
  await enqueueChatPush(env, {
    kind: 'group',
    targetId: 'private-room',
    eventId: 'group-event',
    senderAccountId: 'bob',
    recipientAccountIds: ['alice'],
  });
  await enqueueChatPush(env, {
    kind: 'dm',
    targetId: 'bob',
    eventId: 'dm-event',
    senderAccountId: 'bob',
    recipientAccountIds: ['alice'],
  });
  env.CHAT = { fetch: async () => Response.json({ eligible: false }) } as unknown as Fetcher;
  await env.DB.prepare(
    "INSERT INTO user_blocks(blocker_id,blocked_id,created_at) VALUES('alice','bob',1)",
  ).run();
  env.FCM_SERVICE_ACCOUNT_JSON = await fcmSecret();
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  await runPushDeliveries(env, now);
  expect(network).not.toHaveBeenCalled();
  expect((await rows()).results).toHaveLength(0);
});

it('sends live AI replies but drops a queued notification after its conversation is deleted', async () => {
  await handlePushRegistrations(request('alice', 'PUT'), env, {});
  await env.DB.prepare(
    `INSERT INTO server_conversations(user_id,id,created_at,updated_at,mutation_id)
     VALUES('alice','conversation-1',?,?,?)`,
  )
    .bind(now, now, 'mutation-1')
    .run();
  await env.DB.prepare(
    `INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position)
     VALUES('alice','conversation-1','reply-1','assistant','hello',?,0)`,
  )
    .bind(now)
    .run();
  await prepareAiPushDelivery(env, 'alice', 'conversation-1', 'reply-1', now).run();
  await env.DB.prepare(
    `INSERT INTO server_conversations(user_id,id,created_at,updated_at,mutation_id)
     VALUES('alice','conversation-2',?,?,?)`,
  )
    .bind(now, now, 'mutation-2')
    .run();
  await env.DB.prepare(
    `INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position)
     VALUES('alice','conversation-2','reply-2','assistant','hello again',?,0)`,
  )
    .bind(now)
    .run();
  await prepareAiPushDelivery(env, 'alice', 'conversation-2', 'reply-2', now).run();
  expect((await rows()).results).toHaveLength(2);
  await env.DB.prepare(
    "UPDATE server_conversations SET deleted_at=? WHERE user_id='alice' AND id='conversation-1'",
  )
    .bind(now + 1)
    .run();

  env.FCM_SERVICE_ACCOUNT_JSON = await fcmSecret();
  const sent: unknown[] = [];
  const network = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('oauth2.googleapis.com'))
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    sent.push(JSON.parse(String(init.body)));
    return Response.json({ name: 'projects/project-test/messages/2' });
  });
  vi.stubGlobal('fetch', network);
  await runPushDeliveries(env, now);
  expect(sent).toEqual([
    {
      message: {
        fid,
        data: { kind: 'ai', targetId: 'conversation-2', eventId: 'reply-2', accountId: 'alice' },
        android: { priority: 'high', ttl: '86400s' },
      },
    },
  ]);
  expect((await rows()).results).toHaveLength(1);
});
