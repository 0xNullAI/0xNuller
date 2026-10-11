import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex } from './session-domain';
import { reserveCredits, releaseCredits, settleCredits, type Env } from './index';
import {
  handleAsrBillingReview,
  handleVoiceAttachmentAsr,
  recoverVoiceAttachmentAsr,
} from './voice-attachment-asr';

let testDb: ReturnType<typeof createTestDb>;
let env: Env;
let billing: Parameters<typeof handleVoiceAttachmentAsr>[3];
const audio = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);
const url = 'https://test/api/auth/conversations/s/attachments/clip/transcription';
const result = () =>
  Response.json({
    choices: [{ finish_reason: 'stop', message: { content: '今天有点累' } }],
    usage: { seconds: 3, prompt_tokens: 75, completion_tokens: 5 },
  });

async function request(method = 'GET', body?: unknown, account = 'alice') {
  return handleVoiceAttachmentAsr(
    new Request(url, {
      method,
      headers: { Authorization: `Bearer ${account}`, 'X-Account-Id': account },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    {},
    billing,
  );
}

beforeEach(async () => {
  testDb = createTestDb();
  env = {
    DB: testDb.DB,
    DASHSCOPE_ASR_API_KEY: 'server-only',
    ASR_CREDITS_PER_SECOND: '2',
    PHOTOS: { get: async () => ({ size: audio.length, arrayBuffer: async () => audio.buffer }) },
  } as unknown as Env;
  billing = {
    reserve: (user, key, credits) =>
      reserveCredits(env, user, {
        idempotencyKey: key,
        usageKind: 'agent',
        modelId: 'qwen3-asr-flash',
        credits,
      }),
    settle: (user, key, charge, metadata) => settleCredits(env, user, key, charge, metadata),
    release: (user, key) => releaseCredits(env, user, key),
  };
  for (const id of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,1)',
    )
      .bind(id, id, id, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)',
    )
      .bind(await sha256Hex(id), id, Date.now() + 60000)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO credit_ledger(user_id,amount_credits,kind,reference_id,created_at) VALUES('alice',1000,'admin_gift','gift',1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id) VALUES('alice','s',1,'{}',1,1,'create')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','s','m','user','',1,0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO private_conversation_attachments(user_id,conversation_id,id,message_id,status,kind,mime,size,object_key,created_at) VALUES('alice','s','clip','m','ready','voice','audio/ogg',7,'private/clip',1)",
  ).run();
});
afterEach(() => {
  testDb.close();
  vi.unstubAllGlobals();
});

describe('saved voice ASR billing', () => {
  it('quotes, requires consent, charges trusted provider seconds and persists a private draft', async () => {
    const fetcher = vi.fn(async () => result());
    vi.stubGlobal('fetch', fetcher);
    const quote = await request();
    expect(quote?.status).toBe(200);
    const offer = ((await quote!.json()) as { offer: { maxCredits: number; priceVersion: string } })
      .offer;
    expect(offer.maxCredits).toBe(600);
    expect(
      (
        await request('POST', {
          consent: false,
          acceptedMaxCredits: 600,
          priceVersion: offer.priceVersion,
        })
      )?.status,
    ).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await request('POST', {
      consent: true,
      acceptedMaxCredits: 600,
      priceVersion: offer.priceVersion,
    });
    expect(response?.status).toBe(200);
    const job = (
      (await response!.json()) as { job: { state: string; credits: number; transcript: string } }
    ).job;
    expect(job).toMatchObject({ state: 'succeeded', credits: 6, transcript: '今天有点累' });
    const wallet = await env.DB.prepare(
      "SELECT status,charged_credits FROM credit_reservations WHERE model_id='qwen3-asr-flash'",
    ).first<{ status: string; charged_credits: number }>();
    expect(wallet).toEqual({ status: 'settled', charged_credits: 6 });
    const message = await env.DB.prepare(
      "SELECT content FROM server_conversation_messages WHERE id='m'",
    ).first<{ content: string }>();
    expect(message?.content).toBe(''); // Draft is not a user assertion until confirmed in composer.
    expect(
      (
        await request('POST', {
          consent: true,
          acceptedMaxCredits: 600,
          priceVersion: offer.priceVersion,
        })
      )?.status,
    ).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await request('GET', undefined, 'bob'))?.status).toBe(404);
  });

  it('allows only one concurrent provider call for the same clip and never releases the first hold', async () => {
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const fetcher = vi.fn(async () => {
      await gate;
      return result();
    });
    vi.stubGlobal('fetch', fetcher);
    const offer = (
      (await (await request())!.json()) as { offer: { maxCredits: number; priceVersion: string } }
    ).offer;
    const body = {
      consent: true,
      acceptedMaxCredits: offer.maxCredits,
      priceVersion: offer.priceVersion,
    };
    const first = request('POST', body);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const second = await request('POST', body);
    expect(second?.status).toBe(200);
    expect(((await second!.json()) as { job: { state: string } }).job.state).toBe('running');
    expect(
      (
        await env.DB.prepare(
          "SELECT status FROM credit_reservations WHERE model_id='qwen3-asr-flash'",
        ).first<{ status: string }>()
      )?.status,
    ).toBe('pending');
    unlock();
    expect((await first)?.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('retains ambiguous provider outcomes for review without fake text or charge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout');
      }),
    );
    const offer = (
      (await (await request())!.json()) as { offer: { maxCredits: number; priceVersion: string } }
    ).offer;
    expect(
      (
        await request('POST', {
          consent: true,
          acceptedMaxCredits: offer.maxCredits,
          priceVersion: offer.priceVersion,
        })
      )?.status,
    ).toBe(503);
    const current = await request();
    expect(
      ((await current!.json()) as { job: { state: string; transcript: null } }).job,
    ).toMatchObject({ state: 'needs_review', transcript: null });
    expect(
      await env.DB.prepare(
        "SELECT status,charged_credits FROM credit_reservations WHERE model_id='qwen3-asr-flash'",
      ).first<{ status: string; charged_credits: null }>(),
    ).toEqual({ status: 'pending', charged_credits: null });
    await env.DB.prepare("UPDATE users SET role='admin' WHERE id='bob'").run();
    const review = await handleAsrBillingReview(
      new Request('https://test/api/auth/admin/billing/asr-reconciliation', {
        headers: { Authorization: 'Bearer bob', 'X-Account-Id': 'bob' },
      }),
      env,
      {},
    );
    expect(review?.status).toBe(200);
    const data = (await review!.json()) as { items: Array<Record<string, unknown>> };
    expect(data.items[0]).toMatchObject({
      accountId: 'alice',
      state: 'needs_review',
      reservationStatus: 'pending',
    });
    expect(JSON.stringify(data)).not.toContain('今天有点累');
  });

  it('releases a clear provider rejection but keeps an operator-visible review for uncertainty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('invalid audio', { status: 400 })),
    );
    const offer = (
      (await (await request())!.json()) as { offer: { maxCredits: number; priceVersion: string } }
    ).offer;
    expect(
      (
        await request('POST', {
          consent: true,
          acceptedMaxCredits: offer.maxCredits,
          priceVersion: offer.priceVersion,
        })
      )?.status,
    ).toBe(503);
    expect(
      ((await (await request())!.json()) as { job: { state: string; transcript: null } }).job,
    ).toMatchObject({ state: 'failed', transcript: null });
    expect(
      (
        await env.DB.prepare(
          "SELECT status FROM credit_reservations WHERE model_id='qwen3-asr-flash'",
        ).first<{ status: string }>()
      )?.status,
    ).toBe('released');
  });

  it('uses a distinct wallet key for matching clip IDs in different conversations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => result()),
    );
    await env.DB.prepare(
      "INSERT INTO server_conversations(user_id,id,created_at,metadata,revision,updated_at,mutation_id) VALUES('alice','s2',1,'{}',1,1,'create')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO server_conversation_messages(user_id,conversation_id,id,role,content,created_at,position) VALUES('alice','s2','m','user','',1,0)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO private_conversation_attachments(user_id,conversation_id,id,message_id,status,kind,mime,size,object_key,created_at) VALUES('alice','s2','clip','m','ready','voice','audio/ogg',7,'private/clip2',1)",
    ).run();
    const offer = (
      (await (await request())!.json()) as { offer: { maxCredits: number; priceVersion: string } }
    ).offer;
    const body = {
      consent: true,
      acceptedMaxCredits: offer.maxCredits,
      priceVersion: offer.priceVersion,
    };
    expect((await request('POST', body))?.status).toBe(200);
    const other = await handleVoiceAttachmentAsr(
      new Request(url.replace('/s/', '/s2/'), {
        method: 'POST',
        headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
        body: JSON.stringify(body),
      }),
      env,
      {},
      billing,
    );
    expect(other?.status).toBe(200);
    const keys = await env.DB.prepare(
      "SELECT reservation_key FROM voice_attachment_asr_jobs WHERE attachment_id='clip'",
    ).all<{ reservation_key: string }>();
    expect(new Set(keys.results.map((row) => row.reservation_key)).size).toBe(2);
  });

  it('recovers a persisted provider result without a second provider call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => result()),
    );
    const realSettle = billing.settle;
    billing.settle = vi.fn(async () => {
      throw new Error('DB unavailable');
    });
    const offer = (
      (await (await request())!.json()) as { offer: { maxCredits: number; priceVersion: string } }
    ).offer;
    expect(
      (
        await request('POST', {
          consent: true,
          acceptedMaxCredits: offer.maxCredits,
          priceVersion: offer.priceVersion,
        })
      )?.status,
    ).toBe(503);
    billing.settle = realSettle;
    await recoverVoiceAttachmentAsr(env, billing);
    expect(
      ((await (await request())!.json()) as { job: { state: string; transcript: string } }).job,
    ).toMatchObject({ state: 'succeeded', transcript: '今天有点累' });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });
});
