// DG-Voice Worker 入口。
//
// 两个职责：
//  1. `/api/realtime` —— 体验版（trial）语音代理。前端用「激活密钥」连到这里，Worker
//     校验密钥、按 TrialSession Durable Object 计量（并发/单次时长/每日总量），再用只存在
//     服务端 secret 里的真 xAI Key 打开上游连接、双向转发。真 Key 永不下发前端。
//  2. 其余路径 —— SPA 静态资源托管（各自带 Key 的 provider 仍走浏览器直连，不经过这里）。
import type { Env } from './env.js';
import { isAllowedOrigin, parseActivationKey, resolveTrialKey } from './trial-keys.js';

export { TrialSession } from './trial-session.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/realtime') {
      return handleTrialRealtime(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleTrialRealtime(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('expected a WebSocket upgrade', { status: 426 });
  }
  if (env.TRIAL_DISABLED === '1') {
    return new Response('体验版已暂停', { status: 503 });
  }
  if (!isAllowedOrigin(request.headers.get('Origin'), env)) {
    return new Response('forbidden origin', { status: 403 });
  }

  const activationKey = parseActivationKey(request.headers.get('Sec-WebSocket-Protocol'));
  if (!activationKey) {
    return new Response('缺少激活密钥', { status: 401 });
  }
  const config = resolveTrialKey(env, activationKey, Date.now());
  if (!config) {
    return new Response('激活密钥无效或已过期', { status: 401 });
  }

  // One DO per activation key: it owns concurrency + metering for that key.
  const stub = env.TRIAL_SESSION.get(env.TRIAL_SESSION.idFromName(activationKey));
  const forwarded = new Request(request);
  forwarded.headers.set('x-trial-max-session', String(config.maxSessionMinutes));
  forwarded.headers.set('x-trial-daily-cap', String(config.dailyCapMinutes));
  return stub.fetch(forwarded);
}
