import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex } from './session-domain';
import type { GenerativeScheduleEnv } from './companion-generations';
import { handleCompanionSchedules, runCompanionSchedules } from './companion-schedules';
let db: ReturnType<typeof createTestDb>;
let env: GenerativeScheduleEnv;
const now = Date.parse('2027-01-01T00:00Z');
const due = Date.parse('2027-01-02T12:00Z');
const draft = {
  version: 0,
  relationshipId: 'r',
  conversationId: 'c',
  kind: 'once',
  localDate: '2027-01-02',
  localTime: '12:00',
  timeZone: 'UTC',
  weekdays: [],
  quietStart: '00:00',
  quietEnd: '00:00',
  dailyLimit: 1,
  template: '今天的面试怎么样？',
  paused: false,
};
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  db = createTestDb();
  env = { DB: db.DB } as GenerativeScheduleEnv;
  for (const user of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (?,?,?,?,1)',
    )
      .bind(user, user, user, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,1,?)',
    )
      .bind(await sha256Hex(user), user, now + 365 * 86_400_000)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES ('alice','r','friend','','','','',1,1,1)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id) VALUES ('alice','c',1,'{"relationshipId":"r"}',1,1,'initial')`,
  ).run();
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function call(path = '', method = 'GET', body?: unknown, user = 'alice') {
  return (await handleCompanionSchedules(
    new Request(`https://test/api/auth/companion-schedules${path}`, {
      method,
      headers: { Authorization: `Bearer ${user}`, 'X-Account-Id': user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    {},
  ))!;
}
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
describe('private server companion schedules', () => {
  it('requires owned bound conversations, guards versions and never resurrects deleted jobs', async () => {
    expect((await call('/s', 'PUT', draft, 'bob')).status).toBe(400);
    const created = await call('/s', 'PUT', draft);
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(await (await call('', 'GET', undefined, 'bob')).json()).toMatchObject({ items: [] });
    expect((await call('/s', 'PUT', { ...draft, version: 1, paused: true })).status).toBe(200);
    expect((await call('/s', 'DELETE', { version: 1 })).status).toBe(409);
    expect((await call('/s', 'DELETE', { version: 2 })).status).toBe(200);
    expect((await call('/s', 'PUT', draft)).status).toBe(409);
    await runCompanionSchedules(env, due);
    expect(await count('server_conversation_messages')).toBe(0);
  });
  it('delivers explicit template and notification once with concurrent cron and no Credit charge', async () => {
    await env.DB.prepare(
      "INSERT INTO push_registrations(installation_id,user_id,provider,platform,created_at,updated_at) VALUES('firebase-installation-01','alice','fcm-fid','android',1,1)",
    ).run();
    await call('/s', 'PUT', draft);
    await Promise.all([runCompanionSchedules(env, due), runCompanionSchedules(env, due)]);
    await runCompanionSchedules(env, due + 60_000);
    expect(await count('server_conversation_messages')).toBe(1);
    expect(await count('companion_notifications')).toBe(1);
    expect(await count('companion_deliveries')).toBe(1);
    expect(
      await env.DB.prepare('SELECT kind,target_id,event_id FROM push_deliveries').first(),
    ).toEqual({
      kind: 'ai',
      target_id: 'c',
      event_id: expect.stringMatching(/^scheduled:/),
    });
    expect(await count('credit_ledger')).toBe(0);
    expect(
      await env.DB.prepare('SELECT role,content FROM server_conversation_messages').first(),
    ).toEqual({ role: 'assistant', content: `定时消息\n${draft.template}` });
    expect(await env.DB.prepare('SELECT revision FROM server_conversations').first()).toEqual({
      revision: 2,
    });
    const notification = await env.DB.prepare('SELECT id FROM companion_notifications').first<{
      id: string;
    }>();
    const read = (user: string) =>
      handleCompanionSchedules(
        new Request(
          `https://test/api/auth/companion-notifications/${encodeURIComponent(notification!.id)}/read`,
          { method: 'PUT', headers: { Authorization: `Bearer ${user}` } },
        ),
        env,
        {},
      );
    expect((await read('bob'))?.status).toBe(404);
    expect((await read('alice'))?.status).toBe(200);
    expect(await env.DB.prepare('SELECT read_at FROM companion_notifications').first()).toEqual({
      read_at: now,
    });
  });
  it('pauses jobs after a conversation is deleted and keeps other accounts notifications private', async () => {
    await call('/s', 'PUT', draft);
    await env.DB.prepare('UPDATE server_conversations SET deleted_at=2').run();
    await runCompanionSchedules(env, due);
    expect(await count('server_conversation_messages')).toBe(0);
    expect(
      await env.DB.prepare('SELECT paused,next_run_at FROM companion_schedules').first(),
    ).toEqual({ paused: 1, next_run_at: null });
    const response = await handleCompanionSchedules(
      new Request('https://test/api/auth/companion-notifications', {
        headers: { Authorization: 'Bearer bob' },
      }),
      env,
      {},
    );
    expect(await response?.json()).toMatchObject({ items: [] });
  });
  it('defers quiet time but does not space out fixed reminders the user set up', async () => {
    await call('/quiet', 'PUT', {
      ...draft,
      localTime: '23:00',
      quietStart: '22:00',
      quietEnd: '08:00',
      dailyLimit: 3,
    });
    await runCompanionSchedules(env, Date.parse('2027-01-02T23:00Z'));
    expect(await count('companion_deliveries')).toBe(0);
    await runCompanionSchedules(env, Date.parse('2027-01-03T08:00Z'));
    expect(await count('companion_deliveries')).toBe(1);
    // A second explicit reminder five minutes later is still delivered on time.
    await call('/other', 'PUT', { ...draft, dailyLimit: 3 });
    await runCompanionSchedules(env, Date.parse('2027-01-03T08:05Z'));
    expect(await count('companion_deliveries')).toBe(2);
  });
  it('delivers a fixed reminder on time even when earlier messages were not answered', async () => {
    await call('/remind', 'PUT', { ...draft, dailyLimit: 3 });
    await env.DB.prepare(
      "INSERT INTO companion_deliveries(user_id,schedule_id,occurrence_key,claim_token,message_id,created_at) VALUES('alice','remind','previous','old','previous-message',?)",
    )
      .bind(due - 6 * 3_600_000)
      .run();
    await runCompanionSchedules(env, due);
    expect(await count('server_conversation_messages')).toBe(1);
  });
  it('backs off unanswered AI outreach across schedules of the same relationship and resumes after a reply', async () => {
    await enableModel();
    await call('/first', 'PUT', modelDraft);
    await call('/second', 'PUT', { ...modelDraft, dailyLimit: 3 });
    const previous = due - 6 * 3_600_000;
    await env.DB.prepare(
      "INSERT INTO companion_deliveries(user_id,schedule_id,occurrence_key,claim_token,message_id,created_at) VALUES('alice','first','previous','old','previous-message',?)",
    )
      .bind(previous)
      .run();
    await runCompanionSchedules(env, due);
    expect(await count('server_conversation_messages')).toBe(0);
    expect(
      await env.DB.prepare("SELECT next_run_at FROM companion_schedules WHERE id='second'").first(),
    ).toEqual({ next_run_at: previous + 86_400_000 });
    await env.DB.prepare(
      `INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id)
       VALUES ('alice','another-chat',1,'{"relationshipId":"r"}',1,1,'initial')`,
    ).run();
    await env.DB.prepare(
      "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','another-chat','reply','user','我回来了',?,0)",
    )
      .bind(previous + 60_000)
      .run();
    await runCompanionSchedules(env, previous + 86_400_000);
    expect(await count('server_conversation_messages')).toBe(2);
    expect(await count('companion_deliveries')).toBe(2);
  });
  it('keeps unanswered backoff private to one relationship', async () => {
    await enableModel();
    await call('/first', 'PUT', { ...modelDraft, dailyLimit: 3 });
    await env.DB.prepare(
      "INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES ('alice','other-role','other-friend','','','','',1,1,1)",
    ).run();
    await env.DB.prepare(
      `INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id)
       VALUES ('alice','other-chat',1,'{"relationshipId":"other-role"}',1,1,'initial')`,
    ).run();
    expect(
      (
        await call('/other', 'PUT', {
          ...modelDraft,
          relationshipId: 'other-role',
          conversationId: 'other-chat',
          dailyLimit: 3,
        })
      ).status,
    ).toBe(201);
    await env.DB.prepare(
      "INSERT INTO companion_deliveries(user_id,schedule_id,occurrence_key,claim_token,message_id,created_at) VALUES('alice','first','previous','old','previous-message',?)",
    )
      .bind(due - 6 * 3_600_000)
      .run();
    await runCompanionSchedules(env, due);
    expect(
      await env.DB.prepare('SELECT conversation_id FROM server_conversation_messages').first(),
    ).toEqual({
      conversation_id: 'other-chat',
    });
  });
  it('increases unanswered delay after repeated outreach before model generation or charging', async () => {
    await enableModel();
    await call('/s', 'PUT', modelDraft);
    const first = due - 3 * 86_400_000;
    const second = due - 12 * 3_600_000;
    for (const [key, timestamp] of [
      ['first', first],
      ['second', second],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO companion_deliveries(user_id,schedule_id,occurrence_key,claim_token,message_id,created_at) VALUES('alice','s',?,'old',?,?)",
      )
        .bind(key, key, timestamp)
        .run();
    }
    await runCompanionSchedules(env, due);
    expect(fetch).not.toHaveBeenCalled();
    expect(await count('credit_reservations')).toBe(0);
    expect(await env.DB.prepare('SELECT next_run_at FROM companion_schedules').first()).toEqual({
      next_run_at: second + 2 * 86_400_000,
    });
  });
  it('blocks new schedules and delivery for paused or ended relationships', async () => {
    await call('/s', 'PUT', draft);
    await env.DB.prepare(
      `INSERT INTO companion_life_records(user_id,id,relationship_id,kind,label,title,content,version,created_at,updated_at) VALUES ('alice','stage','r','lifecycle','paused','','',1,1,1)`,
    ).run();
    expect((await call('/new', 'PUT', draft)).status).toBe(400);
    await env.DB.prepare('UPDATE companion_schedules SET paused=0').run();
    await runCompanionSchedules(env, due);
    expect(await count('companion_deliveries')).toBe(0);
    await env.DB.prepare("UPDATE companion_life_records SET label='ended'").run();
    expect((await call('/new', 'PUT', draft)).status).toBe(400);
    await runCompanionSchedules(env, due);
    expect(await count('companion_deliveries')).toBe(0);
  });
  it('rolls back message/outbox/claim on failure then retries the same occurrence without duplication', async () => {
    await call('/s', 'PUT', draft);
    await env.DB.prepare(
      `CREATE TRIGGER fail_scheduled_message BEFORE INSERT ON server_conversation_messages BEGIN SELECT RAISE(ABORT,'temporarily unavailable'); END`,
    ).run();
    await runCompanionSchedules(env, due);
    expect(await count('companion_deliveries')).toBe(0);
    expect(await count('companion_notifications')).toBe(0);
    expect(
      await env.DB.prepare('SELECT attempts,next_run_at FROM companion_schedules').first(),
    ).toEqual({ attempts: 1, next_run_at: due + 60_000 });
    await env.DB.prepare('DROP TRIGGER fail_scheduled_message').run();
    await runCompanionSchedules(env, due + 60_000);
    expect(await count('companion_deliveries')).toBe(1);
    expect(await count('server_conversation_messages')).toBe(1);
  });
});

const modelDraft = {
  ...draft,
  mode: 'model',
  acceptedCredits: 5,
  generationPriceVersion: 'proactive-M2.7-v1:5',
  contextConsent: true,
};
async function enableModel() {
  env.MINIMAX_MEDIA_API_KEY = 'test-only';
  env.PROACTIVE_MESSAGE_CREDITS = '5';
  await env.DB.prepare(
    "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at) VALUES ('alice',100,'manual_purchase','test-topup','v1','{}',1)",
  ).run();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        choices: [{ finish_reason: 'stop', message: { content: '今天过得怎么样？' } }],
      }),
    ),
  );
}
describe('real proactive model schedule', () => {
  it('requires explicit context/price consent and creates one billed message across duplicate cron', async () => {
    await enableModel();
    expect((await call('/s', 'PUT', { ...modelDraft, contextConsent: false })).status).toBe(400);
    expect((await call('/s', 'PUT', modelDraft)).status).toBe(201);
    await Promise.all([runCompanionSchedules(env, due), runCompanionSchedules(env, due)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await count('companion_deliveries')).toBe(1);
    expect(
      await env.DB.prepare('SELECT status,charged_credits FROM credit_reservations').first(),
    ).toEqual({ status: 'settled', charged_credits: 5 });
    const context = await env.DB.prepare(
      'SELECT user_id,conversation_id,run_id,relationship_id FROM reservation_context',
    ).first<{
      user_id: string;
      conversation_id: string;
      run_id: string;
      relationship_id: string;
    }>();
    expect(context).toMatchObject({ user_id: 'alice', conversation_id: 'c', relationship_id: 'r' });
    expect(context?.run_id).toMatch(/^proactive:/);
    await env.DB.prepare(
      "UPDATE companion_schedules SET deleted_at=? WHERE user_id='alice' AND id='s'",
    )
      .bind(due + 1)
      .run();
    await env.DB.prepare(
      `UPDATE server_conversations SET metadata='{"relationshipId":"changed"}' WHERE user_id='alice' AND id='c'`,
    ).run();
    expect(
      await env.DB.prepare(
        'SELECT conversation_id,run_id,relationship_id FROM reservation_context',
      ).first(),
    ).toEqual({ conversation_id: 'c', run_id: context!.run_id, relationship_id: 'r' });
    expect(
      await env.DB.prepare('SELECT content FROM server_conversation_messages').first(),
    ).toEqual({ content: 'AI主动消息\n今天过得怎么样？' });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://api.minimax.io/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'MiniMax-M2.7',
      max_completion_tokens: 1024,
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('tools');
  });
  it('retries a failed generation with backoff, never charges, and pauses after repeated failures', async () => {
    await enableModel();
    vi.mocked(fetch).mockRejectedValue(new Error('timeout'));
    await call('/s', 'PUT', modelDraft);
    const paused = async () =>
      (await env.DB.prepare('SELECT paused FROM companion_schedules').first<{ paused: number }>())
        ?.paused;
    await runCompanionSchedules(env, due);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await paused()).toBe(0);
    await runCompanionSchedules(env, due + 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await runCompanionSchedules(env, due + 5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await runCompanionSchedules(env, due + 15 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await runCompanionSchedules(env, due + 35 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await paused()).toBe(1);
    expect(await count('companion_deliveries')).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM credit_reservations WHERE status<>'released'",
      ).first(),
    ).toEqual({ n: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE kind='usage'").first(),
    ).toEqual({ n: 0 });
  });
  it('checks pause after provider responds and compensates reservation', async () => {
    await enableModel();
    await call('/s', 'PUT', modelDraft);
    vi.mocked(fetch).mockImplementation(async () => {
      await env.DB.prepare('UPDATE companion_schedules SET paused=1,version=version+1').run();
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'hello' } }] });
    });
    await runCompanionSchedules(env, due);
    expect(await count('companion_deliveries')).toBe(0);
    await runCompanionSchedules(env, due + 60000);
    expect(await env.DB.prepare('SELECT status FROM credit_reservations').first()).toEqual({
      status: 'released',
    });
  });
  it('reuses persisted generation after delivery rollback without another model charge', async () => {
    await enableModel();
    await call('/s', 'PUT', modelDraft);
    await env.DB.prepare(
      "CREATE TRIGGER reject_delivery BEFORE INSERT ON companion_notifications BEGIN SELECT RAISE(ABORT,'retry'); END",
    ).run();
    await runCompanionSchedules(env, due);
    expect(await count('companion_deliveries')).toBe(0);
    expect(await env.DB.prepare('SELECT status FROM credit_reservations').first()).toEqual({
      status: 'pending',
    });
    await env.DB.prepare('DROP TRIGGER reject_delivery').run();
    await runCompanionSchedules(env, due + 60000);
    expect(await count('companion_deliveries')).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('sends only owned confirmed memories and user-authored people, never system messages', async () => {
    await enableModel();
    for (const [user, id, state, content] of [
      ['alice', 'active', 'active', 'OWN_CONFIRMED'],
      ['alice', 'draft', 'suggested', 'UNCONFIRMED'],
      ['bob', 'other', 'active', 'OTHER_ACCOUNT'],
    ]) {
      await env.DB.prepare(
        "INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at,scope,relationship_id,state) VALUES (?,?,'note','memory',?,1,1,1,'relationship','r',?)",
      )
        .bind(user, id, content, state)
        .run();
    }
    await env.DB.prepare(
      "INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES ('bob','r','friend','','','','',1,1,1)",
    ).run();
    for (const [user, id, content, deletedAt] of [
      ['alice', 'friend', 'OWN_FRIEND', null],
      ['alice', 'removed', 'DELETED_FRIEND', 10],
      ['bob', 'another-friend', 'OTHER_FRIEND', null],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO companion_life_records(user_id,id,relationship_id,kind,label,title,content,version,created_at,updated_at,deleted_at)
         VALUES (?,?,'r','person','','朋友',?,1,1,1,?)`,
      )
        .bind(user, id, content, deletedAt)
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position)
       VALUES ('alice','c','internal','system','PRIVATE_SYSTEM_AND_DEVICE',1,0),
              ('alice','c','spoken','user','USER_LAST_MESSAGE',2,1)`,
    ).run();
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '<think>private reasoning</think>下午想散步吗？' },
          },
        ],
      }),
    );
    await call('/s', 'PUT', modelDraft);
    await runCompanionSchedules(env, due);
    const sent = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body);
    expect(sent).toContain('OWN_CONFIRMED');
    expect(sent).toContain('OWN_FRIEND');
    expect(sent).toContain('USER_LAST_MESSAGE');
    expect(sent).not.toContain('UNCONFIRMED');
    expect(sent).not.toContain('OTHER_ACCOUNT');
    expect(sent).not.toContain('DELETED_FRIEND');
    expect(sent).not.toContain('OTHER_FRIEND');
    expect(sent).not.toContain('PRIVATE_SYSTEM_AND_DEVICE');
    expect(
      await env.DB.prepare(
        "SELECT content FROM server_conversation_messages WHERE content LIKE 'AI主动消息%'",
      ).first(),
    ).toEqual({ content: 'AI主动消息\n下午想散步吗？' });
  });
  it('rechecks the scheduled private relationship immediately before model submission', async () => {
    await enableModel();
    await call('/s', 'PUT', modelDraft);
    await env.DB.prepare(
      `CREATE TRIGGER rebind_before_generation_context AFTER UPDATE OF updated_at ON companion_generations
       WHEN NEW.state='submitted' AND OLD.updated_at=OLD.created_at
       BEGIN
         UPDATE server_conversations SET metadata='{"relationshipId":"other"}'
         WHERE user_id='alice' AND id='c';
       END`,
    ).run();
    await runCompanionSchedules(env, due);
    expect(fetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status FROM credit_reservations').first()).toEqual({
      status: 'released',
    });
    expect(await count('companion_deliveries')).toBe(0);
  });
  it('expires a interrupted model submission without repeating it', async () => {
    await enableModel();
    await call('/s', 'PUT', modelDraft);
    await env.DB.prepare(
      "INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,created_at,updated_at) VALUES ('proactive:test','alice','agent','minimax:proactive-M2.7',5,'pending',?,?)",
    )
      .bind(due, due)
      .run();
    await env.DB.prepare(
      "INSERT INTO companion_generations(user_id,schedule_id,occurrence_key,schedule_version,reservation_key,state,credits,price_version,created_at,updated_at) SELECT user_id,id,occurrence_key,version,'proactive:test','submitted',5,'proactive-M2.7-v1:5',?,? FROM companion_schedules",
    )
      .bind(due, due)
      .run();
    await runCompanionSchedules(env, due + 600001);
    expect(
      await env.DB.prepare(
        "SELECT status FROM credit_reservations WHERE idempotency_key='proactive:test'",
      ).first(),
    ).toEqual({ status: 'released' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT state FROM companion_generations').first()).toEqual({
      state: 'failed',
    });
  });
  it('pauses on insufficient balance and respects lifecycle deletion before calling provider', async () => {
    await enableModel();
    await env.DB.prepare('DELETE FROM credit_ledger').run();
    await call('/s', 'PUT', modelDraft);
    await runCompanionSchedules(env, due);
    expect(fetch).not.toHaveBeenCalled();
    expect(await count('credit_reservations')).toBe(0);
  });
});

describe('cron fairness', () => {
  it('moves model schedules over the per-run budget back instead of blocking the due list', async () => {
    await enableModel();
    for (const user of ['carol', 'dave', 'erin']) {
      await env.DB.prepare(
        'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (?,?,?,?,1)',
      )
        .bind(user, user, user, 'unused')
        .run();
      await env.DB.prepare(
        'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,1,?)',
      )
        .bind(await sha256Hex(user), user, now + 365 * 86_400_000)
        .run();
      await env.DB.prepare(
        "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at) VALUES (?,100,'manual_purchase',?,'v1','{}',1)",
      )
        .bind(user, `topup-${user}`)
        .run();
      await env.DB.prepare(
        `INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES (?,'r','friend','','','','',1,1,1)`,
      )
        .bind(user)
        .run();
      await env.DB.prepare(
        `INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id) VALUES (?,'c',1,'{"relationshipId":"r"}',1,1,'initial')`,
      )
        .bind(user)
        .run();
      expect((await call('/s', 'PUT', modelDraft, user)).status).toBe(201);
    }
    await runCompanionSchedules(env, due);
    expect(fetch).toHaveBeenCalledTimes(2);
    const waiting = await env.DB.prepare(
      'SELECT next_run_at FROM companion_schedules WHERE next_run_at IS NOT NULL AND next_run_at<?',
    )
      .bind(due + 86_400_000)
      .all<{ next_run_at: number }>();
    expect(waiting.results).toEqual([{ next_run_at: due + 60_000 }]);
  });
});
