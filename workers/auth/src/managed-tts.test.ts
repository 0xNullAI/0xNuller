import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex } from './session-domain';
import { reserveCredits, releaseCredits, settleCredits, type Env } from './index';
import { handleManagedTts, recoverManagedTts } from './managed-tts';
import example from '@0xnullai/ai-pricing/example-price-table.json';

let db: ReturnType<typeof createTestDb>;
let env: Env;
let billing: Parameters<typeof handleManagedTts>[3];
let objects: Map<string, Uint8Array>;
const path = 'https://test/api/auth/managed-tts';
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
// Two Credits per character keeps the arithmetic readable; real prices live in a secret.
const PRICE_TABLE = JSON.stringify({
  ...example,
  tts: { ...example.tts, perTenThousandChars: 20_000 },
});

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
/** Chunked TTS body: audio objects, a sentence object, then the final usage object. */
function chunked(objects: unknown[]) {
  return new Response(objects.map((object) => JSON.stringify(object)).join('\n'));
}
function provider(characters: number | null = 4) {
  return chunked([
    { code: 0, message: '', data: b64(MP3.subarray(0, 8)) },
    { code: 0, message: '', data: b64(MP3.subarray(8)) },
    { code: 0, message: '', data: null, sentence: { text: '你好', words: [] } },
    {
      code: 20000000,
      message: 'OK',
      data: null,
      ...(characters === null ? {} : { usage: { text_words: characters } }),
    },
  ]);
}
function fetcher(characters: number | null = 4) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    provider(characters),
  );
}
async function call(method = 'GET', body?: unknown, account = 'alice', suffix = '') {
  return handleManagedTts(
    new Request(`${path}${suffix}`, {
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
  db = createTestDb();
  objects = new Map();
  env = {
    DB: db.DB,
    VOLC_SPEECH_API_KEY: 'server-only',
    AI_PRICE_TABLE: PRICE_TABLE,
    PHOTOS: {
      put: async (key: string, bytes: Uint8Array) => {
        objects.set(key, bytes);
      },
      get: async (key: string) => {
        const bytes = objects.get(key);
        return bytes
          ? {
              size: bytes.length,
              arrayBuffer: async () =>
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
            }
          : null;
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    },
  } as unknown as Env;
  billing = {
    reserve: (user, key, credits) =>
      reserveCredits(env, user, {
        idempotencyKey: key,
        usageKind: 'agent',
        modelId: 'managed-tts',
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
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('managed Video read-aloud wallet', () => {
  it('requires a current account and explicit exact quote, then settles trusted characters once', async () => {
    const mocked = fetcher();
    vi.stubGlobal('fetch', mocked);
    const quote = await call();
    expect(
      ((await quote!.json()) as { offer: { perTenThousandChars: number } }).offer
        .perTenThousandChars,
    ).toBe(20_000);
    const priceVersion = ((await (await call())!.json()) as { offer: { priceVersion: string } })
      .offer.priceVersion;
    const input = {
      id: 'speech001',
      text: '你好',
      consent: true,
      acceptedMaxCredits: 8,
      priceVersion,
    };
    expect((await call('POST', { ...input, consent: false }))?.status).toBe(409);
    expect(mocked).not.toHaveBeenCalled();
    const output = await call('POST', input);
    expect(output?.status).toBe(200);
    expect(
      (
        (await output!.json()) as {
          job: { state: string; credits: number; audioAvailable: boolean };
        }
      ).job,
    ).toMatchObject({ state: 'succeeded', credits: 8, audioAvailable: true });
    expect(
      (await (await call('GET', undefined, 'alice', '/speech001/audio'))!.arrayBuffer()).byteLength,
    ).toBe(14);
    expect((await call('GET', undefined, 'bob', '/speech001/audio'))?.status).toBe(404);
    expect((await call('POST', input))?.status).toBe(200);
    expect(mocked).toHaveBeenCalledOnce(); // the audio arrives in the synthesis response
    const [url, init] = mocked.mock.calls[0]!;
    expect(url).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    const sent = new Headers(init!.headers);
    expect(sent.get('X-Api-Key')).toBe('server-only');
    expect(sent.get('X-Api-Resource-Id')).toBe('example-tts');
    expect(sent.get('X-Control-Require-Usage-Tokens-Return')).toBe('*');
    expect(JSON.parse(String(init!.body)).req_params).toMatchObject({
      text: '你好',
      speaker: 'zh_female_vv_uranus_bigtts',
    });
    const row = await env.DB.prepare(
      "SELECT status,charged_credits FROM credit_reservations WHERE model_id='managed-tts'",
    ).first();
    expect(row).toEqual({ status: 'settled', charged_credits: 8 });
    expect((await call('POST', { ...input, text: '再见' }))?.status).toBe(409);
  });

  it('quotes supplementary characters by Unicode code point, not UTF-16 units', async () => {
    vi.stubGlobal('fetch', fetcher(2));
    const priceVersion = ((await (await call())!.json()) as { offer: { priceVersion: string } })
      .offer.priceVersion;
    expect(
      (
        await call('POST', {
          id: 'speech002',
          text: '😀',
          consent: true,
          acceptedMaxCredits: 4,
          priceVersion,
        })
      )?.status,
    ).toBe(200);
    expect(
      (
        await call('POST', {
          id: 'speech003',
          text: '😀',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(409);
  });

  it('releases a definite provider rejection, retains uncertainty and never invents usage', async () => {
    const priceVersion = ((await (await call())!.json()) as { offer: { priceVersion: string } })
      .offer.priceVersion;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad request', { status: 400 })),
    );
    expect(
      (
        await call('POST', {
          id: 'speech004',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(503);
    expect(
      (
        await env.DB.prepare(
          "SELECT status FROM credit_reservations WHERE idempotency_key=(SELECT reservation_key FROM managed_tts_jobs WHERE id='speech004')",
        ).first<{ status: string }>()
      )?.status,
    ).toBe('released');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout');
      }),
    );
    expect(
      (
        await call('POST', {
          id: 'speech005',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(503);
    expect(
      (
        await env.DB.prepare(
          "SELECT status FROM credit_reservations WHERE idempotency_key=(SELECT reservation_key FROM managed_tts_jobs WHERE id='speech005')",
        ).first<{ status: string }>()
      )?.status,
    ).toBe('pending');
    expect(objects.size).toBe(0);
  });

  it('recovers saved audio and provider usage after settlement failure without regenerating', async () => {
    const mocked = fetcher();
    vi.stubGlobal('fetch', mocked);
    const realSettle = billing.settle;
    billing.settle = vi.fn(async () => {
      throw new Error('transient DB failure');
    });
    const priceVersion = ((await (await call())!.json()) as { offer: { priceVersion: string } })
      .offer.priceVersion;
    expect(
      (
        await call('POST', {
          id: 'speech006',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(503);
    billing.settle = realSettle;
    await env.DB.prepare("UPDATE managed_tts_jobs SET updated_at=? WHERE id='speech006'")
      .bind(Date.now() - 60_000)
      .run();
    await recoverManagedTts(env, billing);
    expect(
      (
        (await (await call('GET', undefined, 'alice', '/speech006'))!.json()) as {
          job: { state: string };
        }
      ).job.state,
    ).toBe('succeeded');
    expect(mocked).toHaveBeenCalledOnce();
  });

  it('does not debit when recovery finds no saved audio', async () => {
    vi.stubGlobal('fetch', fetcher());
    billing.settle = vi.fn(async () => {
      throw new Error('transient DB failure');
    });
    const priceVersion = ((await (await call())!.json()) as { offer: { priceVersion: string } })
      .offer.priceVersion;
    expect(
      (
        await call('POST', {
          id: 'speech011',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(503);
    objects.delete('users/alice/tts/speech011.mp3');
    await env.DB.prepare("UPDATE managed_tts_jobs SET updated_at=? WHERE id='speech011'")
      .bind(Date.now() - 60_000)
      .run();
    await recoverManagedTts(env, billing);
    expect(
      (
        (await (await call('GET', undefined, 'alice', '/speech011'))!.json()) as {
          job: { state: string };
        }
      ).job.state,
    ).toBe('needs_review');
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM credit_ledger WHERE user_id='alice' AND kind='usage'",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(billing.settle).toHaveBeenCalledOnce();
  });

  it('keeps a recovery task pending when R2 fails transiently', async () => {
    vi.stubGlobal('fetch', fetcher());
    billing.settle = vi.fn(async () => {
      throw new Error('transient DB failure');
    });
    const priceVersion = ((await (await call())!.json()) as { offer: { priceVersion: string } })
      .offer.priceVersion;
    expect(
      (
        await call('POST', {
          id: 'speech012',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(503);
    await env.DB.prepare("UPDATE managed_tts_jobs SET updated_at=? WHERE id='speech012'")
      .bind(Date.now() - 60_000)
      .run();
    env.PHOTOS = {
      ...env.PHOTOS,
      get: async () => {
        throw new Error('R2 unavailable');
      },
    } as unknown as R2Bucket;
    await recoverManagedTts(env, billing);
    expect(
      (
        (await (await call('GET', undefined, 'alice', '/speech012'))!.json()) as {
          job: { state: string };
        }
      ).job.state,
    ).toBe('settlement_pending');
    expect(billing.settle).toHaveBeenCalledOnce();
  });

  it('does not debit after audio expiry, but preserves an already settled receipt', async () => {
    vi.stubGlobal('fetch', fetcher());
    const realSettle = billing.settle;
    billing.settle = vi.fn(async () => {
      throw new Error('transient DB failure');
    });
    const priceVersion = ((await (await call())!.json()) as { offer: { priceVersion: string } })
      .offer.priceVersion;
    expect(
      (
        await call('POST', {
          id: 'speech013',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(503);
    billing.settle = vi.fn(realSettle);
    await env.DB.prepare(
      "UPDATE managed_tts_jobs SET audio_expires_at=1,updated_at=1 WHERE id='speech013'",
    ).run();
    await recoverManagedTts(env, billing);
    expect(billing.settle).not.toHaveBeenCalled();
    expect(
      (
        (await (await call('GET', undefined, 'alice', '/speech013'))!.json()) as {
          job: { state: string };
        }
      ).job.state,
    ).toBe('needs_review');
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM credit_ledger WHERE user_id='alice' AND kind='usage'",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(objects.has('users/alice/tts/speech013.mp3')).toBe(false);

    expect(
      (
        await call('POST', {
          id: 'speech014',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(200);
    await env.DB.prepare(
      "UPDATE managed_tts_jobs SET state='settlement_pending',audio_expires_at=1,updated_at=1 WHERE id='speech014'",
    ).run();
    await recoverManagedTts(env, billing);
    expect(billing.settle).toHaveBeenCalledOnce(); // Only the normal POST, never the expired recovery.
    expect(
      (
        (await (await call('GET', undefined, 'alice', '/speech014'))!.json()) as {
          job: { state: string; audioAvailable: boolean };
        }
      ).job,
    ).toMatchObject({ state: 'succeeded', audioAvailable: false });
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM credit_ledger WHERE reference_id=(SELECT reservation_key FROM managed_tts_jobs WHERE id='speech014')",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it('queues private audio cleanup when an account is deleted', async () => {
    vi.stubGlobal('fetch', fetcher());
    const priceVersion = ((await (await call())!.json()) as { offer: { priceVersion: string } })
      .offer.priceVersion;
    expect(
      (
        await call('POST', {
          id: 'speech007',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(200);
    const object = await env.DB.prepare(
      "SELECT object_key FROM managed_tts_jobs WHERE id='speech007'",
    ).first<{ object_key: string }>();
    expect(object?.object_key).toBe('users/alice/tts/speech007.mp3');
    await env.DB.prepare("DELETE FROM users WHERE id='alice'").run();
    const queued = await env.DB.prepare(
      'SELECT object_key FROM private_attachment_deletions WHERE object_key=?',
    )
      .bind(object!.object_key)
      .first<{ object_key: string }>();
    expect(queued?.object_key).toBe(object?.object_key);
  });

  it('does not write R2 audio if account deletion removes the task during provider synthesis', async () => {
    const priceVersion = ((await (await call())!.json()) as { offer: { priceVersion: string } })
      .offer.priceVersion;
    const mocked = vi.fn(async () => {
      await env.DB.prepare("DELETE FROM users WHERE id='alice'").run();
      return provider();
    });
    vi.stubGlobal('fetch', mocked);
    expect(
      (
        await call('POST', {
          id: 'speech009',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(503);
    expect(mocked).toHaveBeenCalledOnce();
    expect(objects.size).toBe(0);
  });

  it('re-queues R2 cleanup if account deletion races the object write and deletion fails', async () => {
    const priceVersion = ((await (await call())!.json()) as { offer: { priceVersion: string } })
      .offer.priceVersion;
    vi.stubGlobal('fetch', fetcher());
    env.PHOTOS = {
      ...env.PHOTOS,
      put: async (key: string, bytes: Uint8Array) => {
        await env.DB.prepare("DELETE FROM users WHERE id='alice'").run();
        objects.set(key, bytes);
        await env.DB.prepare('DELETE FROM private_attachment_deletions WHERE object_key=?')
          .bind(key)
          .run();
      },
      delete: async () => {
        throw new Error('R2 temporarily unavailable');
      },
    } as unknown as R2Bucket;
    expect(
      (
        await call('POST', {
          id: 'speech010',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(503);
    const key = 'users/alice/tts/speech010.mp3';
    expect(objects.has(key)).toBe(true);
    expect(
      (
        await env.DB.prepare(
          'SELECT object_key FROM private_attachment_deletions WHERE object_key=?',
        )
          .bind(key)
          .first<{ object_key: string }>()
      )?.object_key,
    ).toBe(key);
  });

  it('recovers an already settled debit after hold expiry without charging again', async () => {
    vi.stubGlobal('fetch', fetcher());
    const priceVersion = ((await (await call())!.json()) as { offer: { priceVersion: string } })
      .offer.priceVersion;
    expect(
      (
        await call('POST', {
          id: 'speech008',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion,
        })
      )?.status,
    ).toBe(200);
    await env.DB.prepare(
      "UPDATE managed_tts_jobs SET state='settlement_pending',created_at=1,updated_at=1 WHERE id='speech008'",
    ).run();
    await recoverManagedTts(env, billing);
    expect(
      (
        (await (await call('GET', undefined, 'alice', '/speech008'))!.json()) as {
          job: { state: string };
        }
      ).job.state,
    ).toBe('succeeded');
    const ledger = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM credit_ledger WHERE reference_id=(SELECT reservation_key FROM managed_tts_jobs WHERE id='speech008')",
    ).first<{ count: number }>();
    expect(ledger?.count).toBe(1);
  });

  it('stays disabled without the speech key or a valid price table, never using a default price', async () => {
    const mocked = fetcher();
    vi.stubGlobal('fetch', mocked);
    for (const patch of [
      { VOLC_SPEECH_API_KEY: undefined },
      { AI_PRICE_TABLE: undefined },
      { AI_PRICE_TABLE: '{}' },
    ]) {
      const configured = env;
      env = { ...configured, ...patch } as Env;
      expect(await (await call())!.json()).toEqual({ enabled: false, offer: null });
      expect(
        (
          await call('POST', {
            id: 'speech020',
            text: '你好',
            consent: true,
            acceptedMaxCredits: 8,
            priceVersion: 'tts:example-1',
          })
        )?.status,
      ).toBe(503);
      env = configured;
    }
    expect(mocked).not.toHaveBeenCalled();
  });

  it('sends a chosen catalog voice and rejects an unknown one before reserving', async () => {
    const mocked = fetcher();
    vi.stubGlobal('fetch', mocked);
    const input = {
      id: 'speech021',
      text: '你好',
      consent: true,
      acceptedMaxCredits: 8,
      priceVersion: 'tts:example-1',
    };
    expect((await call('POST', { ...input, voice: 'alloy' }))?.status).toBe(400);
    expect(mocked).not.toHaveBeenCalled();
    // A voice saved for the previous provider is mapped, not rejected.
    expect((await call('POST', { ...input, voice: 'ara' }))?.status).toBe(200);
    expect(JSON.parse(String(mocked.mock.calls[0]![1]!.body)).req_params.speaker).toBe(
      'zh_female_xiaohe_uranus_bigtts',
    );
  });

  it('keeps the hold for review when the provider omits billed characters', async () => {
    vi.stubGlobal('fetch', fetcher(null));
    expect(
      (
        await call('POST', {
          id: 'speech022',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion: 'tts:example-1',
        })
      )?.status,
    ).toBe(503);
    const job = await env.DB.prepare(
      "SELECT j.state,r.status FROM managed_tts_jobs j JOIN credit_reservations r ON r.idempotency_key=j.reservation_key WHERE j.id='speech022'",
    ).first();
    expect(job).toEqual({ state: 'needs_review', status: 'pending' });
    expect(objects.size).toBe(0);
  });

  it('releases a stream that is rejected before any audio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chunked([{ code: 45000000, message: 'speaker permission denied' }])),
    );
    expect(
      (
        await call('POST', {
          id: 'speech023',
          text: '你好',
          consent: true,
          acceptedMaxCredits: 8,
          priceVersion: 'tts:example-1',
        })
      )?.status,
    ).toBe(503);
    expect(
      await env.DB.prepare(
        "SELECT j.state,r.status FROM managed_tts_jobs j JOIN credit_reservations r ON r.idempotency_key=j.reservation_key WHERE j.id='speech023'",
      ).first(),
    ).toEqual({ state: 'failed', status: 'released' });
  });
});
