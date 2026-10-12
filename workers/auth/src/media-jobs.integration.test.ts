import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createTestDb, TEST_PRICE_TABLE, testPriceTable } from './test-helpers';
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
  priceVersion: 'ark-image:example-1:20',
};
const generated = () =>
  Response.json({
    data: [{ b64_json: btoa(String.fromCharCode(...png)) }],
    usage: { generated_images: 1 },
  });
/** Seeds the bound character card (optionally with a Market portrait) and a recent message. */
async function seedCharacter(portraitId?: string) {
  await env.DB.prepare(
    `INSERT INTO content_entities(id,owner_id,kind,name,payload,created_at,updated_at) VALUES ('alice:friend','alice','scene','阿澄',?,1,1)`,
  )
    .bind(
      JSON.stringify({
        kind: 'character',
        prompt: '银发，蓝色外套',
        ...(portraitId ? { marketPortraitId: portraitId } : {}),
      }),
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO user_content_refs(user_id,content_id,client_id,created_at,updated_at) VALUES ('alice','alice:friend','friend',1,1)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES ('alice','c','m1','user','我们去海边吧',1,0)`,
  ).run();
}
const sentBody = (index = 0) =>
  JSON.parse(String(vi.mocked(fetch).mock.calls[index]?.[1]?.body)) as Record<string, unknown>;
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  db = createTestDb();
  objects = new Map();
  env = {
    DB: db.DB,
    VOLC_ARK_API_KEY: 'test-only',
    IMAGE_GENERATION_ENABLED: '1',
    AI_PRICE_TABLE: TEST_PRICE_TABLE,
    PHOTOS: {
      head: vi.fn(async (k: string) => objects.get(k) ?? null),
      get: vi.fn(async (k: string) => {
        const o = objects.get(k);
        return o
          ? {
              ...o,
              body: o.bytes,
              size: o.bytes.length,
              arrayBuffer: async () => o.bytes.slice().buffer,
            }
          : null;
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
    vi.fn(async () => generated()),
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
    // Off until the owner opens it, even with a key and a price table.
    delete env.IMAGE_GENERATION_ENABLED;
    const closed = await call();
    expect(closed.status).toBe(503);
    expect(await closed.json()).toMatchObject({ error: '图片生成暂未开放' });
    env.IMAGE_GENERATION_ENABLED = '1';
    delete env.VOLC_ARK_API_KEY;
    expect((await call()).status).toBe(503);
    env.VOLC_ARK_API_KEY = 'test-only';
    delete env.AI_PRICE_TABLE;
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: '管理员尚未配置媒体价格' });
    expect(await row()).toBeNull();
  });
  it('offers one image capability priced from the table', async () => {
    const list = async () =>
      (await handleMediaJobs(
        new Request('https://test/api/auth/media-capabilities', {
          headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
        }),
        env,
        {},
      ))!.json();
    expect(await list()).toEqual({
      items: [
        {
          kind: 'image',
          model: testPriceTable.image.model,
          credits: 20,
          priceVersion: 'ark-image:example-1:20',
          enabled: true,
          reason: null,
        },
      ],
    });
    delete env.AI_PRICE_TABLE;
    expect(await list()).toMatchObject({
      items: [{ kind: 'image', enabled: false, credits: null, reason: '管理员尚未配置媒体价格' }],
    });
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
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
    expect(sentBody()).toMatchObject({
      model: testPriceTable.image.model,
      prompt: draft.prompt,
      response_format: 'b64_json',
      watermark: false,
    });
    expect(sentBody()).not.toHaveProperty('image');
    expect(
      await env.DB.prepare("SELECT metadata_json FROM credit_ledger WHERE kind='usage'").first(),
    ).toEqual({
      metadata_json: JSON.stringify({
        kind: 'image',
        model: `ark:${testPriceTable.image.model}`,
        jobId: 'job_00001',
      }),
    });
  });
  it('uses only explicitly selected owned character and scene snapshots', async () => {
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
  it('rejects new video and selfie requests but keeps old video jobs readable', async () => {
    const video = await call('job_00001', 'PUT', { ...draft, kind: 'video' });
    expect(video.status).toBe(400);
    expect(await video.json()).toEqual({ error: '角色视频已下线' });
    expect((await call('job_00001', 'PUT', { ...draft, kind: 'selfie' })).status).toBe(400);
    expect(await row()).toBeNull();
    for (const [id, state] of [
      ['old_video_done', 'succeeded'],
      ['old_video_wait', 'processing'],
    ]) {
      await env.DB.prepare(
        `INSERT INTO media_jobs(user_id,id,relationship_id,conversation_id,kind,prompt,request_json,credits,price_version,reservation_key,state,upstream_id,object_key,mime,next_run_at,created_at,updated_at)
         VALUES ('alice',?,'r','c','video','旧视频','{}',100,'legacy',?,?,'task',?,'video/mp4',0,?,?)`,
      )
        .bind(id, `media:${id}`, state, `users/alice/photos/media-${id}`, now, now)
        .run();
      await env.DB.prepare(
        "INSERT INTO credit_reservations(idempotency_key,user_id,usage_kind,model_id,reserved_credits,status,created_at,updated_at) VALUES (?,'alice','video','legacy',100,?,?,?)",
      )
        .bind(`media:${id}`, state === 'succeeded' ? 'settled' : 'pending', now, now)
        .run();
    }
    objects.set('users/alice/photos/media-old_video_done', {
      bytes: new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112]),
      httpMetadata: { contentType: 'video/mp4' },
    });
    const done = await call('old_video_done', 'GET');
    expect(await done.json()).toMatchObject({ item: { kind: 'video', state: 'succeeded' } });
    const content = await handleMediaJobs(
      new Request('https://test/api/auth/media-jobs/old_video_done/content', {
        headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      }),
      env,
      {},
    );
    expect(content?.headers.get('Content-Type')).toBe('video/mp4');
    // An unfinished video can no longer complete: its hold is released, nothing is charged.
    await runMediaJobs(env, now);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT state,last_error FROM media_jobs WHERE id='old_video_wait'",
      ).first(),
    ).toEqual({ state: 'failed', last_error: '角色视频已下线，已释放Credit' });
    expect(
      await env.DB.prepare(
        "SELECT status FROM credit_reservations WHERE idempotency_key='media:old_video_wait'",
      ).first(),
    ).toEqual({ status: 'released' });
    expect(await charged()).toEqual({ n: 0 });
  });
  it('「让角色出镜」 sends the private portrait, card, scene and recent messages', async () => {
    await seedCharacter('00000000-0000-4000-8000-000000000001');
    await env.DB.prepare(
      "INSERT INTO user_photos(id,user_id,object_key,visibility,created_at,slot,status) VALUES ('portrait','alice','users/alice/photos/portrait','private',1,0,'ready')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO character_appearances(user_id,relationship_id,photo_id,scale,position,version) VALUES ('alice','r','portrait',35,'right',1)",
    ).run();
    objects.set('users/alice/photos/portrait', {
      bytes: png,
      httpMetadata: { contentType: 'image/png' },
    });
    const market = vi.fn();
    env.MARKET = { fetch: market } as unknown as Fetcher;
    expect((await call('job_00001', 'PUT', { ...draft, featureCharacter: true })).status).toBe(201);
    const prompt = String((await row())?.prompt);
    expect(prompt).toContain('银发，蓝色外套');
    expect(prompt).toContain('我们去海边吧');
    await runMediaJobs(env, now);
    expect((await row())?.state).toBe('succeeded');
    expect(sentBody().image).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...png))}`);
    expect(String(sentBody().prompt)).toContain('参考图是该角色的形象');
    expect(market).not.toHaveBeenCalled();
  });
  it('「让角色出镜」 falls back to the Market portrait, then to the text description', async () => {
    await seedCharacter('00000000-0000-4000-8000-000000000001');
    const market = vi.fn<(url: string) => Promise<Response>>(
      async () => new Response(png, { headers: { 'Content-Type': 'image/png' } }),
    );
    env.MARKET = { fetch: market } as unknown as Fetcher;
    expect((await call('job_00001', 'PUT', { ...draft, featureCharacter: true })).status).toBe(201);
    await runMediaJobs(env, now);
    expect(String(market.mock.calls[0]?.[0])).toBe(
      'https://market.internal/api/items/character-portraits/00000000-0000-4000-8000-000000000001/content',
    );
    expect(String(sentBody(0).image)).toMatch(/^data:image\/png;base64,/);
    market.mockResolvedValue(new Response(null, { status: 404 }));
    expect((await call('job_00002', 'PUT', { ...draft, featureCharacter: true })).status).toBe(201);
    await runMediaJobs(env, now + 1);
    expect(sentBody(1)).not.toHaveProperty('image');
    expect(String(sentBody(1).prompt)).toContain('银发，蓝色外套');
    expect(String(sentBody(1).prompt)).not.toContain('参考图');
    expect(await charged()).toEqual({ n: 2 });
  });
  it('「让角色出镜」 still requires the bound character card', async () => {
    expect((await call('job_00001', 'PUT', { ...draft, featureCharacter: true })).status).toBe(409);
    expect(await row()).toBeNull();
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
