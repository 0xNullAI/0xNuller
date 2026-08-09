// Trial (体验版) voice Worker.
//
// One job only: `/api/realtime` — the trial voice proxy. The frontend connects
// here with an 「激活密钥」, and the Worker validates the key, meters it through
// the TrialSession Durable Object (concurrency / per-session length / daily
// total), then opens the upstream connection with the real xAI key that only
// exists as a server-side secret and forwards both directions. The real key is
// never handed down to the frontend.
//
// BYO-key providers (xAI / OpenAI / Azure / 智谱) connect straight from the
// browser and never come through here. Static assets are served by the unified
// shell — this Worker no longer hosts any pages.
import type { Env } from './env.js';
import { isAllowedOrigin, parseActivationKey, resolveTrialKey } from './trial-keys.js';

export { TrialSession } from './trial-session.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/realtime') {
      return handleTrialRealtime(request, env);
    }
    // In production the route only hands /api/realtime to this Worker, so this
    // is unreachable there; the workers.dev preview address does reach it.
    // Return 404 instead of hitting env.ASSETS — that binding no longer exists.
    return new Response('not found', { status: 404 });
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
