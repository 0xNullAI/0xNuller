import { describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import type { Env } from './env.js';

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
    XAI_API_KEY: 'xai-secret',
    ALLOWED_ORIGINS: 'https://0xnullai.com',
    VOICE_SESSION: namespace,
    AUTH: {
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
    const response = await worker.fetch(request('account-ticket'), env);
    expect(response.status).toBe(200);
    expect(env.VOICE_SESSION.idFromName).toHaveBeenCalledWith('user-1');
    expect(forwarded[0]?.headers.get('x-voice-ticket')).toBe('account-ticket');
    expect(forwarded[0]?.headers.get('x-voice-max-credits')).toBe('500');
    expect(forwarded[0]?.headers.get('x-voice-reservation')).toBeTruthy();
  });

  it('Credit 不足时不创建会话', async () => {
    const { env } = environment(vi.fn(async () => ({ ...balance, total: 10, available: 10 })));
    expect((await worker.fetch(request(), env)).status).toBe(402);
    expect(env.VOICE_SESSION.get).not.toHaveBeenCalled();
  });
});
