import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex, type SessionEnv } from './session-domain';
import { handleCreditActivity } from './credit-activity';
let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  for (const user of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (?,?,?,?,1)',
    )
      .bind(user, user, user, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,1,?)',
    )
      .bind(await sha256Hex(user), user, Date.now() + 86400000)
      .run();
  }
});
afterEach(() => db.close());
describe('unified credit activity', () => {
  it('projects media and proactive consumption without exposing private provider metadata', async () => {
    for (const [user, kind, ref] of [
      ['alice', 'proactive', 'p'],
      ['alice', 'selfie', 's'],
      ['bob', 'image', 'other'],
    ])
      await env.DB.prepare(
        "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at) VALUES (?,-5,'usage',?,'v1',?,1)",
      )
        .bind(
          user,
          ref,
          JSON.stringify({
            kind,
            model: 'test',
            prompt: 'PRIVATE_PROMPT',
            apiKey: 'TEST_NOT_A_SECRET',
          }),
        )
        .run();
    const result = await handleCreditActivity(
      new Request('https://test/api/auth/credits/activity', {
        headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      }),
      env,
      {},
    );
    const body = (await result!.json()) as { entries: Array<{ usageType: string }> };
    expect(body.entries.map((x) => x.usageType)).toEqual(['selfie', 'proactive']);
    expect(JSON.stringify(body)).not.toContain('PRIVATE_PROMPT');
    expect(JSON.stringify(body)).not.toContain('TEST_NOT_A_SECRET');
    expect(result!.headers.get('Cache-Control')).toBe('no-store');
  });
});

async function timeline(cursor?: string, user = 'alice', account = user) {
  return (await handleCreditActivity(
    new Request(
      `https://test/api/auth/credits/activity?view=timeline${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { headers: { Authorization: `Bearer ${user}`, 'X-Account-Id': account } },
    ),
    env,
    {},
  ))!;
}
async function hold(
  key: string,
  status = 'pending',
  kind = 'agent',
  user = 'alice',
  updated = Date.now(),
) {
  await env.DB.prepare(
    'INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,charged_credits,created_at,updated_at) VALUES(?,?,?,?,20,?,?,42,?)',
  )
    .bind(
      key,
      user,
      kind,
      kind === 'voice' ? 'voice' : 'balanced',
      status,
      status === 'settled' ? 3 : null,
      updated,
    )
    .run();
}
interface Page {
  entries: Array<{
    id: string;
    referenceId: string;
    usageType: string;
    status: string;
    amountCredits: number | null;
    conversationId: string | null;
    taskId: string | null;
    anomaly: string | null;
    holdActive: boolean;
  }>;
  nextCursor: string | null;
}
const readPage = async (response: Response) => (await response.json()) as Page;
it('merges a settled reservation with its ledger and preserves pending/released/expired states', async () => {
  await hold('settled:key', 'settled');
  await hold('pending:key');
  await hold('released:key', 'released');
  await hold('expired:key', 'pending', 'agent', 'alice', 1);
  await env.DB.prepare(
    "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at) VALUES('alice',-3,'usage','settled:key','price','{}',43)",
  ).run();
  const page = await readPage(await timeline());
  expect(page.entries).toHaveLength(4);
  expect(page.entries.find((x) => x.referenceId === 'settled:key')).toMatchObject({
    amountCredits: -3,
    status: 'settled',
    conversationId: null,
    taskId: null,
  });
  expect(page.entries.find((x) => x.referenceId === 'pending:key')).toMatchObject({
    amountCredits: null,
    status: 'pending',
    holdActive: true,
  });
  expect(page.entries.find((x) => x.referenceId === 'released:key')).toMatchObject({
    amountCredits: null,
    status: 'released',
    holdActive: false,
  });
  expect(page.entries.find((x) => x.referenceId === 'expired:key')).toMatchObject({
    anomaly: 'expired_hold',
    holdActive: false,
  });
});
it('uses owner-scoped media provenance and omits raw errors, prompts and capability', async () => {
  await hold('media:key', 'pending', 'video');
  await hold('private:key', 'pending', 'voice', 'bob');
  await env.DB.prepare(
    `INSERT INTO media_jobs(user_id,id,relationship_id,conversation_id,kind,prompt,request_json,credits,price_version,reservation_key,state,object_key,next_run_at,created_at,updated_at,last_error) VALUES('alice','job-id','relation-id','conversation-id','video','PRIVATE_PROMPT','{}',20,'v','media:key','submission_unknown','PRIVATE_OBJECT',1,1,1,'RAW_PROVIDER_ERROR')`,
  ).run();
  await env.DB.prepare(
    "INSERT INTO text_billing_outbox(reservation_key,capability,state,updated_at) VALUES('media:key','PRIVATE_CAPABILITY','needs_review',1)",
  ).run();
  const response = await timeline();
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const page = await readPage(response);
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0]).toMatchObject({
    usageType: 'generated_video',
    conversationId: 'conversation-id',
    taskId: 'job-id',
    anomaly: 'needs_review',
  });
  for (const secret of [
    'PRIVATE_PROMPT',
    'PRIVATE_OBJECT',
    'RAW_PROVIDER_ERROR',
    'PRIVATE_CAPABILITY',
    'private:key',
  ])
    expect(JSON.stringify(page)).not.toContain(secret);
  expect((await timeline(undefined, 'alice', 'bob')).status).toBe(403);
});

it('labels managed TTS separately from Agent and exposes review state without audio keys', async () => {
  await env.DB.prepare(
    "INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,created_at,updated_at) VALUES('tts:task','alice','agent','managed-tts',20,'pending',1,1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO managed_tts_jobs(user_id,id,text_hash,reservation_key,state,max_credits,object_key,price_version,created_at,updated_at) VALUES('alice','speech001','hash','tts:task','needs_review',20,'PRIVATE_AUDIO_KEY','tts-v1',1,1)",
  ).run();
  const page = await readPage(await timeline());
  expect(page.entries[0]).toMatchObject({
    usageType: 'tts',
    taskId: 'speech001',
    anomaly: 'needs_review',
  });
  expect(JSON.stringify(page)).not.toContain('PRIVATE_AUDIO_KEY');
});
it('paginates equal timestamps without duplicating a reservation after settlement', async () => {
  for (let i = 0; i < 32; i++) await hold(`timeline:${String(i).padStart(3, '0')}`);
  const first = await readPage(await timeline());
  expect(first.entries).toHaveLength(30);
  await env.DB.prepare(
    "UPDATE credit_reservations SET status='released' WHERE idempotency_key='timeline:031'",
  ).run();
  const second = await readPage(await timeline(first.nextCursor!));
  expect(second.entries).toHaveLength(2);
  expect(new Set([...first.entries, ...second.entries].map((e) => e.id)).size).toBe(32);
  expect((await timeline('broken')).status).toBe(400);
});

it('reads a persisted billing snapshot instead of mutable current conversation metadata', async () => {
  await hold('voice:context', 'settled', 'voice');
  await env.DB.prepare(
    "INSERT INTO reservation_context(reservation_key,user_id,conversation_id,run_id,relationship_id,created_at) VALUES('voice:context','alice','original-chat','actual:call:001','original-relation',42)",
  ).run();
  const response = await timeline();
  const page = (await response.json()) as {
    entries: Array<{ conversationId: string; runId: string; relationshipId: string }>;
  };
  expect(page.entries[0]).toMatchObject({
    conversationId: 'original-chat',
    runId: 'actual:call:001',
    relationshipId: 'original-relation',
  });
});

it('projects signed group AI provenance only to its paying member', async () => {
  await hold('group-ai:alice', 'settled', 'agent');
  await env.DB.prepare(
    "INSERT INTO group_ai_reservation_context(reservation_key,user_id,room_id,trigger_id,role_id,created_at) VALUES('group-ai:alice','alice','room-7','message-3','role-2',42)",
  ).run();
  const page = (await timeline().then((response) => response.json())) as {
    entries: Array<{
      roomId: string | null;
      triggerId: string | null;
      roleId: string | null;
      conversationId: string | null;
    }>;
  };
  expect(page.entries[0]).toMatchObject({
    roomId: 'room-7',
    triggerId: 'message-3',
    roleId: 'role-2',
    conversationId: null,
  });
  const other = await readPage(await timeline(undefined, 'bob'));
  expect(other.entries).toEqual([]);
});

it('shows an expired Voice review as released and uncharged without exposing private evidence', async () => {
  await hold('voice:expired', 'released', 'voice');
  await env.DB.prepare(
    "INSERT INTO voice_billing_reviews(reservation_key,user_id,reason,requested_action,observed_duration_ms,requested_credits,reserved_credits,price_version,hold_updated_at,created_at) VALUES('voice:expired','alice','reservation_expired','settle',40000,80,80,'credits-2026-09',1,2)",
  ).run();
  const page = await readPage(await timeline());
  expect(page.entries[0]).toMatchObject({
    referenceId: 'voice:expired',
    usageType: 'voice',
    status: 'released',
    amountCredits: null,
    anomaly: 'voice_hold_expired',
    holdActive: false,
  });
  const other = await readPage(await timeline(undefined, 'bob'));
  expect(other.entries).toEqual([]);
});
