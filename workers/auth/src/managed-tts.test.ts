import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex } from './session-domain';
import { reserveCredits, releaseCredits, settleCredits, type Env } from './index';
import { handleManagedTts, recoverManagedTts } from './managed-tts';

let db: ReturnType<typeof createTestDb>;
let env: Env;
let billing: Parameters<typeof handleManagedTts>[3];
let objects: Map<string, Uint8Array>;
const providerUrl =
  'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a/clip.mp3?signature=test';
const path = 'https://test/api/auth/managed-tts';

function provider(characters = 4) {
  return Response.json({
    output: {
      finish_reason: 'stop',
      audio: { url: providerUrl, expires_at: Math.floor(Date.now() / 1000) + 3600 },
    },
    usage: { characters },
  });
}
function fetcher(characters = 4) {
  return vi.fn(async (url: string) =>
    url.includes('SpeechSynthesizer')
      ? provider(characters)
      : new Response(
          new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]),
        ),
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
    DASHSCOPE_TTS_API_KEY: 'server-only',
    DASHSCOPE_WORKSPACE_ID: 'workspace123',
    TTS_CREDITS_PER_CHARACTER: '2',
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
        modelId: 'cosyvoice-v3-flash',
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
      ((await quote!.json()) as { offer: { rate: number; priceVersion: string } }).offer.rate,
    ).toBe(2);
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
    expect(mocked).toHaveBeenCalledTimes(2); // one synthesis, one private audio fetch
    const row = await env.DB.prepare(
      "SELECT status,charged_credits FROM credit_reservations WHERE model_id='cosyvoice-v3-flash'",
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
    expect(mocked).toHaveBeenCalledTimes(2);
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
    const mocked = vi.fn(async (url: string) => {
      if (url.includes('SpeechSynthesizer')) {
        await env.DB.prepare("DELETE FROM users WHERE id='alice'").run();
        return provider();
      }
      return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x64]));
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
    expect(mocked).toHaveBeenCalledTimes(2);
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
});
