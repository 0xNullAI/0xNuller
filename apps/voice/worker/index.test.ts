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

function environment(authorize: Env['AUTH']['authorizeVoiceTicket']): {
  env: Env;
  forwarded: Request[];
} {
  const forwarded: Request[] = [];
  const stub = {
    fetch: vi.fn(async (next: Request) => {
      forwarded.push(next);
      return new Response('forwarded');
    }),
  };
  return {
    forwarded,
    env: {
      XAI_API_KEY: 'xai-secret',
      TRIAL_ALLOWED_ORIGINS: 'https://0xnullai.com',
      TRIAL_SESSION: {
        idFromName: vi.fn((name: string) => name as unknown as DurableObjectId),
        get: vi.fn(() => stub),
      } as unknown as DurableObjectNamespace,
      AUTH: {
        authorizeVoiceTicket: authorize,
        consumeVoiceTicket: vi.fn(),
      },
    },
  };
}

describe('账户语音体验入口', () => {
  it('拒绝无效账户票据', async () => {
    const { env } = environment(vi.fn(async (): Promise<'unauthorized'> => 'unauthorized'));
    expect((await worker.fetch(request(), env)).status).toBe(401);
  });

  it('按账户路由 Durable Object，并且只转发短期票据', async () => {
    const { env, forwarded } = environment(
      vi.fn(async () => ({ subject: 'user-1', allowed: true, remaining: 59, limit: 60 })),
    );
    const response = await worker.fetch(request('account-ticket'), env);
    expect(response.status).toBe(200);
    expect(env.TRIAL_SESSION.idFromName).toHaveBeenCalledWith('user-1');
    expect(forwarded[0]?.headers.get('x-voice-ticket')).toBe('account-ticket');
  });

  it('在账户额度耗尽时不创建会话', async () => {
    const { env } = environment(
      vi.fn(async () => ({ subject: 'user-1', allowed: false, remaining: 0, limit: 60 })),
    );
    expect((await worker.fetch(request(), env)).status).toBe(429);
    expect(env.TRIAL_SESSION.get).not.toHaveBeenCalled();
  });
});
