/**
 * GLM-Realtime auth diagnostic. A browser WebSocket handshake failure (a 401
 * during the upgrade) does NOT expose the server's response body to JS — the
 * browser just fires `onerror` with no detail — so a rejected token looks
 * identical to any other failure in-app. This script signs a JWT with the
 * EXACT algorithm the app uses, then does a plain HTTPS GET (not a WS upgrade)
 * so the server's real error body IS visible:
 *
 *   - token REJECTED  -> HTTP 401 {"error":{"message":"令牌..."}}
 *   - token ACCEPTED  -> a different error about the request not being a
 *                        WebSocket upgrade (proves auth passed; the only
 *                        remaining variable is then the browser Origin check)
 *
 * Usage (key read from an env var, so it never lands in shell history):
 *   ZHIPU_API_KEY='{id}.{secret}' node scripts/glm-connftest.mjs
 */
const GLM_REALTIME_HTTPS = 'https://open.bigmodel.cn/api/paas/v4/realtime';

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlJson = (v) => b64url(new TextEncoder().encode(JSON.stringify(v)));

async function signZhipuJwt(apiKey, expireSeconds = 3600) {
  const i = apiKey.indexOf('.');
  if (i <= 0) throw new Error('key must be {id}.{secret}');
  const id = apiKey.slice(0, i);
  const secret = apiKey.slice(i + 1);
  const now = Date.now();
  const header = { alg: 'HS256', typ: 'JWT', sign_type: 'SIGN' };
  const payload = { api_key: id, exp: now + expireSeconds * 1000, timestamp: now };
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

const apiKey = process.env.ZHIPU_API_KEY;
if (!apiKey) {
  console.error("Set ZHIPU_API_KEY='{id}.{secret}' first.");
  process.exit(1);
}

const jwt = await signZhipuJwt(apiKey);
const res = await fetch(`${GLM_REALTIME_HTTPS}?Authorization=${encodeURIComponent(jwt)}`);
const body = await res.text();
console.log('HTTP', res.status);
console.log(body.slice(0, 400));
if (res.status === 401) {
  console.log('\n=> token REJECTED. The signed JWT is not accepted by Zhipu.');
} else {
  console.log(
    '\n=> token ACCEPTED (non-401). Auth is fine; any in-app failure is the browser WS/Origin layer, not the token.',
  );
}
