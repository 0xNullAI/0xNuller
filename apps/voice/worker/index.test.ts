import { describe, expect, it, vi } from 'vitest';
import example from '@0xnullai/ai-pricing/example-price-table.json';
import { parsePriceTable, realtimeReservation } from '@0xnullai/ai-pricing';
import worker from './index.js';
import type { Env } from './env.js';

const route = parsePriceTable(example)!.realtime;

function request(ticket = 'signed-ticket'): Request {
  return new Request('https://0xnullai.com/api/realtime', {
    headers: {
      Upgrade: 'websocket',
      Origin: 'https://0xnullai.com',
      'Sec-WebSocket-Protocol': `realtime, openai-insecure-api-key.${ticket}`,
    },
  });
}

function environment(authorize: Env['AUTH']['authorizeVoiceTicket']) {
  const forwarded: Request[] = [];
  const stub = {
    fetch: vi.fn(async (next: Request) => {
      forwarded.push(next);
      return new Response('forwarded');
    }),
  };
  const namespace = {
    idFromName: vi.fn((name: string) => name as unknown as DurableObjectId),
    get: vi.fn(() => stub),
  } as unknown as DurableObjectNamespace;
  const env: Env = {
    VOLC_SPEECH_API_KEY: 'speech-secret',
    AI_PRICE_TABLE: JSON.stringify(example),
    ALLOWED_ORIGINS: 'https://0xnullai.com',
    VOICE_SESSION: namespace,
    AUTH: {
      finalizeVoiceReservation: vi.fn(),
      authorizeVoiceTicket: authorize,
      reserveVoiceCredits: vi.fn(),
      settleVoiceCredits: vi.fn(),
      releaseVoiceCredits: vi.fn(),
    },
  };
  return { env, forwarded };
}

const balance = { subject: 'user-1', total: 500, reserved: 0, available: 500 };

describe('账户语音 Credit 入口', () => {
  it('拒绝无效账户票据', async () => {
    const { env } = environment(vi.fn(async (): Promise<'unauthorized'> => 'unauthorized'));
    expect((await worker.fetch(request(), env)).status).toBe(401);
  });

  it('按账户路由 Durable Object，并转发票据和 Credit 上限', async () => {
    const { env, forwarded } = environment(vi.fn(async () => balance));
    const forged = request('account-ticket');
    forged.headers.set('x-voice-subject', 'another-account');
    const response = await worker.fetch(forged, env);
    expect(response.status).toBe(200);
    expect(env.VOICE_SESSION.idFromName).toHaveBeenCalledWith('user-1');
    expect(forwarded[0]?.headers.get('x-voice-ticket')).toBe('account-ticket');
    expect(forwarded[0]?.headers.get('x-voice-subject')).toBe('user-1');
    // The hold covers the session cap at the usage bound, or the whole balance if smaller.
    expect(forwarded[0]?.headers.get('x-voice-max-credits')).toBe(
      String(Math.min(500, realtimeReservation(route, 20))),
    );
    expect(forwarded[0]?.headers.get('x-voice-reservation')).toBeTruthy();
  });

  it('Credit 不足一分钟用量时不创建会话', async () => {
    const short = realtimeReservation(route, 1) - 1;
    const { env } = environment(
      vi.fn(async () => ({ ...balance, total: short, available: short })),
    );
    expect((await worker.fetch(request(), env)).status).toBe(402);
    expect(env.VOICE_SESSION.get).not.toHaveBeenCalled();
  });

  it('缺少语音密钥或价格表时关闭服务，不按默认价计费', async () => {
    for (const patch of [{ VOLC_SPEECH_API_KEY: undefined }, { AI_PRICE_TABLE: undefined }]) {
      const authorize = vi.fn(async () => balance);
      const { env } = environment(authorize);
      Object.assign(env, patch);
      expect((await worker.fetch(request(), env)).status).toBe(503);
      expect(authorize).not.toHaveBeenCalled();
    }
  });
});

it('forwards explicit call context but discards forged internal headers', async () => {
  const { env, forwarded } = environment(vi.fn(async () => balance));
  const source = request();
  source.headers.set('x-voice-conversation', 'forged');
  source.headers.set('x-voice-run', 'forged');
  await worker.fetch(source, env);
  expect(forwarded[0]?.headers.get('x-voice-conversation')).toBeNull();
  await worker.fetch(
    new Request(source.url + '?conversationId=private-chat&runId=call:actual:001', source),
    env,
  );
  expect(forwarded[1]?.headers.get('x-voice-conversation')).toBe('private-chat');
  expect(forwarded[1]?.headers.get('x-voice-run')).toBe('call:actual:001');
});
