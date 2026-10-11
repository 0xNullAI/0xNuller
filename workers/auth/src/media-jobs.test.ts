import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex } from './session-domain';
import { handleMediaJobs, runMediaJobs, type MediaEnv } from './media-jobs';
import { handleCreditActivity } from './credit-activity';
import { VALID_PNG as png } from './test-image';
let db: ReturnType<typeof createTestDb>;
let env: MediaEnv;
let objects: Map<string, { bytes: Uint8Array; httpMetadata: { contentType: string } }>;
const now = 1_800_000_000_000;
const draft = {
  kind: 'image',
  prompt: '一位坐在窗边看书的朋友',
  relationshipId: 'r',
  conversationId: 'c',
  useConversationContext: false,
  acceptedCredits: 20,
  priceVersion: 'minimax-media-v1:image:20',
};
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  db = createTestDb();
  objects = new Map();
  env = {
    DB: db.DB,
    MINIMAX_MEDIA_API_KEY: 'test-only',
    MEDIA_IMAGE_CREDITS: '20',
    MEDIA_VIDEO_CREDITS: '100',
    PHOTOS: {
      head: vi.fn(async (k: string) => objects.get(k) ?? null),
      get: vi.fn(async (k: string) => {
        const o = objects.get(k);
        return o ? { ...o, body: o.bytes } : null;
      }),
      put: vi.fn(async (k: string, b: Uint8Array, m: { httpMetadata: { contentType: string } }) => {
        objects.set(k, { bytes: b, ...m });
      }),
      delete: vi.fn(async (k: string) => {
        objects.delete(k);
      }),
    },
  } as unknown as MediaEnv;
  for (const user of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (?,?,?,?,1)',
    )
      .bind(user, user, user, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,1,?)',
    )
      .bind(await sha256Hex(user), user, now + 86400000)
      .run();
    await env.DB.prepare(
      "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at) VALUES (?,500,'manual_purchase',?,'v1','{}',1)",
    )
      .bind(user, user)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO character_relationships(user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES ('alice','r','friend','','','','',1,1,1)",
  ).run();
  await env.DB.prepare(
    `INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id) VALUES ('alice','c',1,'{"relationshipId":"r","promptPresetId":"friend"}',1,1,'initial')`,
  ).run();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        data: { image_base64: [btoa(String.fromCharCode(...png))] },
        base_resp: { status_code: 0 },
      }),
    ),
  );
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const call = async (id = 'job_00001', method = 'PUT', body: unknown = draft, user = 'alice') =>
  (await handleMediaJobs(
    new Request(`https://test/api/auth/media-jobs/${id}`, {
      method,
      headers: { Authorization: `Bearer ${user}`, 'X-Account-Id': user },
      ...(method === 'PUT' ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    {},
  ))!;
const row = () => env.DB.prepare('SELECT * FROM media_jobs').first<Record<string, unknown>>();
const reservation = () =>
  env.DB.prepare('SELECT status,charged_credits FROM credit_reservations').first();
const charged = () =>
  env.DB.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE kind='usage'").first();
describe('private media jobs and unified credit ledger', () => {
  it('pages every generated card with stable time and id order without crossing accounts', async () => {
    for (let index = 0; index < 102; index++) {
      const id = `job_${String(index).padStart(5, '0')}`;
      await env.DB.prepare(
        `INSERT INTO media_jobs(user_id,id,relationship_id,conversation_id,kind,prompt,request_json,credits,price_version,reservation_key,state,object_key,next_run_at,created_at,updated_at)
         VALUES ('alice',?,'r','c','image',?,'{}',20,'v',?,'failed','',0,?,?)`,
      )
        .bind(id, id, `reservation:${id}`, 100, 100)
        .run();
    }
    const list = async (before?: string, account = 'alice') => {
      const url = new URL('https://test/api/auth/media-jobs');
      url.searchParams.set('conversationId', 'c');
      if (before) url.searchParams.set('before', before);
      const response = await handleMediaJobs(
        new Request(url, {
          headers: { Authorization: `Bearer ${account}`, 'X-Account-Id': account },
        }),
        env,
        {},
      );
      return response!;
    };
    const first = await list();
    const firstBody = (await first.json()) as {
      items: Array<{ id: string }>;
      nextBefore: string | null;
    };
    expect(firstBody.items).toHaveLength(100);
    expect(firstBody.items.at(-1)?.id).toBe('job_00099');
    expect(firstBody.nextBefore).toBeTruthy();
    const secondBody = (await (await list(firstBody.nextBefore!)).json()) as {
      items: Array<{ id: string }>;
      nextBefore: string | null;
    };
    expect(secondBody.items).toHaveLength(2);
    expect(secondBody.items.map((item) => item.id)).toEqual(['job_00100', 'job_00101']);
    expect(secondBody.nextBefore).toBeNull();
    expect(new Set([...firstBody.items, ...secondBody.items].map((item) => item.id)).size).toBe(
      102,
    );
    expect(((await (await list(undefined, 'bob')).json()) as { items: unknown[] }).items).toEqual(
      [],
    );
    expect((await list('invalid')).status).toBe(400);
  });

  it('requires enabled capability and owned conversation; accepts only current quoted prices', async () => {
    expect((await call('job_00001', 'PUT', draft, 'bob')).status).toBe(400);
    expect((await call('job_00001', 'PUT', { ...draft, acceptedCredits: 1 })).status).toBe(409);
    delete env.MINIMAX_MEDIA_API_KEY;
    expect((await call()).status).toBe(503);
    expect(await row()).toBeNull();
  });
  it('atomically reserves and replays identical jobs without second reservation or changed content', async () => {
    expect((await call()).status).toBe(201);
    expect((await call()).status).toBe(200);
    expect((await call('job_00001', 'PUT', { ...draft, prompt: 'another' })).status).toBe(409);
    expect((await call('job_00001', 'GET', undefined, 'bob')).status).toBe(404);
    await runMediaJobs(env, now);
    expect((await row())?.state).toBe('succeeded');
    expect(await reservation()).toEqual({ status: 'settled', charged_credits: 20 });
    expect(await charged()).toEqual({ n: 1 });
    expect(await env.DB.prepare('SELECT status,visibility FROM user_photos').first()).toEqual({
      status: 'ready',
      visibility: 'private',
    });
    await runMediaJobs(env, now + 300000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await charged()).toEqual({ n: 1 });
    const [, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(String(options?.body))).toMatchObject({
      model: 'image-01',
      n: 1,
      response_format: 'base64',
    });
  });
  it('uses only explicitly selected owned character and scene snapshots for image and video', async () => {
    await env.DB.prepare(
      "UPDATE character_relationships SET notes='只属于私人的记忆' WHERE user_id='alice' AND id='r'",
    ).run();
    await env.DB.prepare(
      `UPDATE server_conversations SET metadata='{"relationshipId":"r","promptPresetId":"friend","sceneId":"park"}' WHERE user_id='alice' AND id='c'`,
    ).run();
    for (const [id, kind, name, prompt] of [
      ['friend', 'character', '阿澄', '银发，蓝色外套'],
      ['park', 'scene', '公园', '秋天的树下'],
    ]) {
      await env.DB.prepare(
        `INSERT INTO content_entities(id,owner_id,kind,name,payload,created_at,updated_at) VALUES (?,?, 'scene',?,?,1,1)`,
      )
        .bind(`alice:${id}`, 'alice', name, JSON.stringify({ kind, prompt }))
        .run();
      await env.DB.prepare(
        `INSERT INTO user_content_refs(user_id,content_id,client_id,created_at,updated_at) VALUES ('alice',?,?,1,1)`,
      )
        .bind(`alice:${id}`, id)
        .run();
    }
    const selected = { ...draft, useCharacterContext: true };
    expect((await call('job_00001', 'PUT', selected)).status).toBe(201);
    expect(String((await row())?.prompt)).toContain('阿澄');
    expect(String((await row())?.prompt)).toContain('秋天的树下');
    expect(String((await row())?.prompt)).not.toContain('只属于私人的记忆');
    expect((await call('job_00001', 'PUT', selected)).status).toBe(200);
    expect((await call('job_00001', 'PUT', draft)).status).toBe(409);
    const video = {
      ...selected,
      kind: 'video',
      acceptedCredits: 100,
      priceVersion: 'minimax-media-v1:video:100',
    };
    expect((await call('job_00002', 'PUT', video)).status).toBe(201);
    const rows = await env.DB.prepare('SELECT prompt FROM media_jobs WHERE id=?')
      .bind('job_00002')
      .first<{ prompt: string }>();
    expect(rows?.prompt).toContain('银发，蓝色外套');
    expect(rows?.prompt).toContain('秋天的树下');
  });
  it('fails closed when an opted-in card is missing, belongs to another account, or binds a different character', async () => {
    await env.DB.prepare(
      `UPDATE server_conversations SET metadata='{"relationshipId":"r","promptPresetId":"friend"}' WHERE user_id='alice' AND id='c'`,
    ).run();
    const selected = { ...draft, useCharacterContext: true };
    expect((await call('job_00001', 'PUT', selected)).status).toBe(409);
    await env.DB.prepare(
      `INSERT INTO content_entities(id,owner_id,kind,name,payload,created_at,updated_at) VALUES ('bob:friend','bob','scene','Bob','{"kind":"character","prompt":"Bob secret"}',1,1)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_content_refs(user_id,content_id,client_id,created_at,updated_at) VALUES ('bob','bob:friend','friend',1,1)`,
    ).run();
    expect((await call('job_00001', 'PUT', selected)).status).toBe(409);
    expect(await row()).toBeNull();
    await env.DB.prepare(
      `UPDATE server_conversations SET metadata='{"relationshipId":"r","promptPresetId":"other"}' WHERE user_id='alice' AND id='c'`,
    ).run();
    expect((await call('job_00001', 'PUT', selected)).status).toBe(400);
  });
  it('rejects an unavailable selected scene instead of silently omitting it', async () => {
    await env.DB.prepare(
      `UPDATE server_conversations SET metadata='{"relationshipId":"r","promptPresetId":"friend","sceneId":"missing"}' WHERE user_id='alice' AND id='c'`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO content_entities(id,owner_id,kind,name,payload,created_at,updated_at) VALUES ('alice:friend','alice','scene','Friend','{"kind":"character","prompt":"silver hair"}',1,1)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_content_refs(user_id,content_id,client_id,created_at,updated_at) VALUES ('alice','alice:friend','friend',1,1)`,
    ).run();
    expect((await call('job_00001', 'PUT', { ...draft, useCharacterContext: true })).status).toBe(
      409,
    );
    expect(await row()).toBeNull();
    expect(await reservation()).toBeNull();
  });
  it('rolls back job if reservation write fails', async () => {
    await env.DB.prepare(
      "CREATE TRIGGER broken_credit BEFORE INSERT ON credit_reservations BEGIN SELECT RAISE(ABORT,'test'); END",
    ).run();
    await expect(call()).rejects.toThrow();
    expect(await row()).toBeNull();
  });
  it('releases unknown submissions and never repeats non-idempotent upstream POST', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('timeout'));
    await call();
    await runMediaJobs(env, now);
    expect((await row())?.state).toBe('submission_unknown');
    expect(await reservation()).toEqual({ status: 'released', charged_credits: null });
    await runMediaJobs(env, now + 300000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(objects.size).toBe(0);
  });
  it('defers an unknown submission when storage cannot confirm whether a result was saved', async () => {
    await call();
    vi.mocked(fetch).mockRejectedValue(new Error('provider timeout'));
    vi.mocked(env.PHOTOS.head)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('storage offline'));
    await runMediaJobs(env, now);
    expect((await row())?.state).toBe('storing');
    expect(await reservation()).toEqual({ status: 'pending', charged_credits: null });
    await runMediaJobs(env, now + 30_000);
    expect((await row())?.state).toBe('submission_unknown');
    expect(await reservation()).toEqual({ status: 'released', charged_credits: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('recovers durable result after restart and settles exactly once', async () => {
    await call();
    const job = (await row())!;
    await env.DB.prepare(
      "INSERT INTO user_photos(id,user_id,object_key,visibility,created_at,slot,status) VALUES (?,'alice',?,'private',1,0,'uploading')",
    )
      .bind(job.photo_id, job.object_key)
      .run();
    objects.set(String(job.object_key), { bytes: png, httpMetadata: { contentType: 'image/png' } });
    await env.DB.prepare("UPDATE media_jobs SET state='submitting'").run();
    await runMediaJobs(env, now);
    expect((await row())?.state).toBe('succeeded');
    expect(fetch).not.toHaveBeenCalled();
    expect(await charged()).toEqual({ n: 1 });
  });
  it('keeps a saved image and its hold when settlement fails, then settles without another provider POST', async () => {
    await call();
    await env.DB.prepare(
      "CREATE TRIGGER media_ledger_offline BEFORE INSERT ON credit_ledger BEGIN SELECT RAISE(ABORT,'test ledger outage'); END",
    ).run();
    await runMediaJobs(env, now);
    const job = (await row())!;
    expect(job.state).toBe('storing');
    expect(objects.has(String(job.object_key))).toBe(true);
    expect(await reservation()).toEqual({ status: 'pending', charged_credits: null });
    expect(await charged()).toEqual({ n: 0 });
    expect(
      await env.DB.prepare('SELECT status FROM user_photos WHERE id=?').bind(job.photo_id).first(),
    ).toEqual({ status: 'uploading' });
    expect(fetch).toHaveBeenCalledTimes(1);

    await env.DB.prepare('DROP TRIGGER media_ledger_offline').run();
    await runMediaJobs(env, now + 30_000);
    expect((await row())?.state).toBe('succeeded');
    expect(await reservation()).toEqual({ status: 'settled', charged_credits: 20 });
    expect(await charged()).toEqual({ n: 1 });
    expect(
      await env.DB.prepare('SELECT status FROM user_photos WHERE id=?').bind(job.photo_id).first(),
    ).toEqual({ status: 'ready' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not debit an expired hold when a stored result is recovered late', async () => {
    await call();
    const job = (await row())!;
    await env.DB.prepare(
      "INSERT INTO user_photos(id,user_id,object_key,visibility,created_at,slot,status) VALUES (?,'alice',?,'private',1,0,'uploading')",
    )
      .bind(job.photo_id, job.object_key)
      .run();
    objects.set(String(job.object_key), { bytes: png, httpMetadata: { contentType: 'image/png' } });
    await env.DB.prepare("UPDATE media_jobs SET state='submitting'").run();
    const late = now + 2 * 60 * 60 * 1000 + 1;
    vi.spyOn(Date, 'now').mockReturnValue(late);
    await runMediaJobs(env, late);
    expect((await row())?.state).toBe('storing');
    expect(await reservation()).toEqual({ status: 'released', charged_credits: null });
    expect(await charged()).toEqual({ n: 0 });
    expect(
      await env.DB.prepare('SELECT reason FROM media_billing_reviews WHERE user_id=? AND job_id=?')
        .bind('alice', 'job_00001')
        .first(),
    ).toEqual({ reason: 'reservation_expired' });
    expect(objects.has(String(job.object_key))).toBe(true);
    expect(
      ((await (await call('job_00001', 'GET')).json()) as { item: { state: string } }).item.state,
    ).toBe('needs_review');
    expect((await call('job_00001', 'DELETE')).status).toBe(409);
    expect((await call('job_00001', 'GET', undefined, 'bob')).status).toBe(404);
    const activity = await handleCreditActivity(
      new Request('https://test/api/auth/credits/activity?view=timeline', {
        headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      }),
      env,
      {},
    );
    const entries = (await activity!.json()) as {
      entries: Array<{
        taskId: string | null;
        recoveryState: string | null;
        anomaly: string | null;
      }>;
    };
    expect(entries.entries.find((entry) => entry.taskId === 'job_00001')).toMatchObject({
      recoveryState: 'needs_review',
      anomaly: 'needs_review',
    });
    await runMediaJobs(env, late + 300_000);
    expect(objects.has(String(job.object_key))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('settles a saved result even after the job timeout if its original hold is still valid', async () => {
    await call();
    const job = (await row())!;
    await env.DB.prepare(
      "INSERT INTO user_photos(id,user_id,object_key,visibility,created_at,slot,status) VALUES (?,'alice',?,'private',1,0,'uploading')",
    )
      .bind(job.photo_id, job.object_key)
      .run();
    objects.set(String(job.object_key), { bytes: png, httpMetadata: { contentType: 'image/png' } });
    await env.DB.prepare("UPDATE media_jobs SET state='submitting'").run();
    const late = now + 3_600_001;
    vi.spyOn(Date, 'now').mockReturnValue(late);
    await runMediaJobs(env, late);
    expect((await row())?.state).toBe('succeeded');
    expect(await reservation()).toEqual({ status: 'settled', charged_credits: 20 });
    expect(await charged()).toEqual({ n: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('quarantines a stored result with a conflicting ledger instead of showing it as paid', async () => {
    await call();
    const job = (await row())!;
    await env.DB.prepare(
      "INSERT INTO user_photos(id,user_id,object_key,visibility,created_at,slot,status) VALUES (?,'alice',?,'private',1,0,'uploading')",
    )
      .bind(job.photo_id, job.object_key)
      .run();
    objects.set(String(job.object_key), { bytes: png, httpMetadata: { contentType: 'image/png' } });
    await env.DB.prepare("UPDATE media_jobs SET state='submitting'").run();
    await env.DB.prepare(
      "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,price_version,metadata_json,created_at) VALUES ('alice',-10,'usage',?,'v1','{}',?)",
    )
      .bind(job.reservation_key, now)
      .run();
    await runMediaJobs(env, now);
    expect((await row())?.state).toBe('storing');
    expect(await reservation()).toEqual({ status: 'pending', charged_credits: null });
    expect(
      await env.DB.prepare('SELECT reason FROM media_billing_reviews WHERE user_id=? AND job_id=?')
        .bind('alice', 'job_00001')
        .first(),
    ).toEqual({ reason: 'ledger_mismatch' });
    expect(
      ((await (await call('job_00001', 'GET')).json()) as { item: { state: string } }).item.state,
    ).toBe('needs_review');
    expect(
      await env.DB.prepare('SELECT status FROM user_photos WHERE id=?').bind(job.photo_id).first(),
    ).toEqual({ status: 'uploading' });
    expect((await call('job_00001', 'GET')).status).toBe(200);
    expect(
      (
        await handleMediaJobs(
          new Request('https://test/api/auth/media-jobs/job_00001/content', {
            headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
          }),
          env,
          {},
        )
      )?.status,
    ).toBe(404);
    expect(objects.has(String(job.object_key))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('polls actual video REST contract and saves before charging', async () => {
    await call('job_00001', 'PUT', {
      ...draft,
      kind: 'video',
      acceptedCredits: 100,
      priceVersion: 'minimax-media-v1:video:100',
    });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ task_id: 'task_1' }));
    await runMediaJobs(env, now);
    expect((await row())?.state).toBe('processing');
    expect(await charged()).toEqual({ n: 0 });
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          task: { status: 'succeeded', content: { url: 'https://cdn.hailuoai.com/asset.mp4' } },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 0, 0, 0, 0])),
      );
    await runMediaJobs(env, now + 60000);
    expect((await row())?.state).toBe('succeeded');
    expect(await reservation()).toEqual({ status: 'settled', charged_credits: 100 });
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe(
      'https://api.minimax.io/v2/query/video_generation/task_1',
    );
  });
  it('never submits a job that changed after the cron snapshot was read', async () => {
    await call();
    const prepare = env.DB.prepare.bind(env.DB);
    let raced = false;
    env.DB.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (!sql.startsWith('SELECT * FROM media_jobs m')) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        const bound = bind(...values);
        const all = bound.all.bind(bound);
        bound.all = (async () => {
          const snapshot = await all();
          if (!raced) {
            raced = true;
            // The user deletes the queued job after the snapshot but before the claim.
            expect((await call('job_00001', 'DELETE')).status).toBe(200);
          }
          return snapshot;
        }) as typeof bound.all;
        return bound;
      };
      return statement;
    }) as typeof env.DB.prepare;
    await runMediaJobs(env, now);
    expect(raced).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect((await row())?.state).toBe('deleting');
    expect(await reservation()).toEqual({ status: 'released', charged_credits: null });
    expect(await charged()).toEqual({ n: 0 });
  });
  it('cancels deleted bindings and retains failed R2 deletion for retry', async () => {
    await call();
    await env.DB.prepare('UPDATE server_conversations SET deleted_at=1').run();
    await runMediaJobs(env, now);
    expect(fetch).not.toHaveBeenCalled();
    expect(await reservation()).toEqual({ status: 'released', charged_credits: null });
    expect((await call('job_00001', 'DELETE')).status).toBe(200);
    vi.mocked(env.PHOTOS.delete).mockRejectedValueOnce(new Error('offline'));
    await runMediaJobs(env, now);
    expect((await row())?.state).toBe('deleting');
    await runMediaJobs(env, now + 300000);
    expect((await row())?.state).toBe('deleted');
    expect((await call()).status).toBe(409);
  });
});
