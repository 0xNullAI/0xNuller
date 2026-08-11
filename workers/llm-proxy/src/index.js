/**
 * 0xnullai-llm-proxy — Cloudflare Worker
 *
 * The free provider's LLM relay. The upstream key is injected server-side
 * (PROXY_API_KEY) and never reaches the browser.
 *
 * Who is allowed to spend that key is decided in `guard.js`; read the comment
 * at the top of that file before changing anything here. The short version:
 * every check is opt-in by configuration, so an unconfigured deployment
 * behaves exactly as this worker always has, and the free provider cannot be
 * taken down by a half-finished rollout.
 *
 * Deploy:
 *   wrangler deploy
 *   wrangler secret put PROXY_API_KEY       # upstream gateway key
 *   wrangler secret put FREE_PROXY_SECRET   # optional; must equal the client's
 *                                           # VITE_DG_PROXY_SECRET
 *   # PROXY_MODEL and ALLOWED_ORIGINS are [vars] in wrangler.toml
 *   # Bind the custom domain llm.0xnullai.com in the dashboard
 *     (Workers > 0xnullai-llm-proxy > Settings > Domains & Routes).
 */

import { checkSignature, corsHeaders, createMemoryLimiter, originAllowed } from './guard.js';

const UPSTREAM = 'https://aihub.071129.xyz/v1/chat/completions';
const MAX_REQUESTS_PER_MINUTE = 10;
const MAX_TOKENS = 2048;

const allowFromMemory = createMemoryLimiter(MAX_REQUESTS_PER_MINUTE);

function json(status, data, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

/**
 * Cloudflare's Rate Limiting binding when it is bound, the per-isolate counter
 * when it is not. The fallback is deliberately still here: a missing binding
 * should weaken the limit, not remove it.
 */
async function withinRateLimit(env, ip, nowMin) {
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      return success;
    } catch {
      // Fall through — a limiter that is erroring must not become an outage.
    }
  }
  return allowFromMemory(ip, nowMin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);

    if (!originAllowed(origin, env.ALLOWED_ORIGINS)) {
      // No CORS headers on this one: the browser must not be able to read the
      // body, and there is nothing here for a disallowed origin to read.
      return new Response(JSON.stringify({ error: '来源不被允许' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json(405, { error: '仅支持 POST 请求' }, cors);
    }

    const now = Date.now();
    const authorization = request.headers.get('Authorization');
    const quota = await env.AUTH.consumeAiQuota(
      {
        authorization: authorization === 'Bearer free' ? null : authorization,
        cookie: request.headers.get('Cookie'),
      },
      'text',
      1,
    );
    if (quota === 'unauthorized') {
      return json(401, { error: '请先登录后使用体验模型' }, cors);
    }
    if (!quota.allowed) {
      return json(429, { error: '今日体验额度已用完，请明天再试或配置自己的模型服务' }, cors);
    }

    const verdict = await checkSignature(request.headers, env.FREE_PROXY_SECRET, now);
    if (verdict === 'stale') {
      return json(403, { error: '请求已过期，请检查设备时间后重试' }, cors);
    }
    if (verdict !== 'ok') {
      return json(403, { error: '签名校验失败' }, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!(await withinRateLimit(env, ip, Math.floor(now / 60000)))) {
      return json(
        429,
        { error: `请求过于频繁，每分钟最多 ${MAX_REQUESTS_PER_MINUTE} 条，请稍后再试。` },
        cors,
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: '请求体格式错误' }, cors);
    }

    // Force the upstream model server-side so the frontend stays agnostic, and
    // cap the spend per request. Any caller-supplied key is dropped rather than
    // forwarded.
    body.model = env.PROXY_MODEL || 'openrouter/free';
    body.max_tokens = Math.min(body.max_tokens || MAX_TOKENS, MAX_TOKENS);
    delete body.max_output_tokens;
    delete body.api_key;
    delete body.apiKey;

    if (!env.PROXY_API_KEY) {
      return json(500, { error: '服务端未配置 PROXY_API_KEY' }, cors);
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.PROXY_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return json(
        502,
        { error: '代理请求失败: ' + (e && e.message ? e.message : String(e)) },
        cors,
      );
    }

    if (body.stream) {
      // Pass the SSE stream straight through.
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      });
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
