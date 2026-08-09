/**
 * Who is allowed to spend the free provider's upstream key.
 *
 * This worker relays to a **paid** upstream with the key injected server-side,
 * and the free provider is a promise to users rather than a feature that may
 * degrade — so the failure mode to avoid is not "someone gets in", it is
 * "everyone is locked out". Every check below is therefore *opt-in by
 * configuration*: with nothing set, behaviour is exactly what it was, and each
 * check only starts refusing traffic once the operator has supplied the thing
 * it needs. See deploy.md for the order to set them in.
 *
 * What was here before: `Access-Control-Allow-Origin: *`, no request auth at
 * all, and a per-isolate in-memory counter. Meanwhile the client has been
 * signing `X-DG-Timestamp` with HMAC-SHA256 into `X-DG-Signature` since the
 * Android build shipped — and nothing on this side ever read either header.
 * The signature was dead on arrival, which is worse than having none, because
 * it reads like protection in code review.
 *
 * **The signature is a speed bump, not authentication.** The secret is inlined
 * into an APK, so anyone willing to unpack one can mint valid signatures
 * forever. What it does stop is the realistic case: someone finds the
 * subdomain and points a script at it. Treating it as more than that would be
 * a mistake.
 */

/** Requests older than this are refused, so a captured signature is not reusable forever. */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Whether an Origin may use this worker.
 *
 * A request with **no** Origin passes: native apps (the Android WebView, and
 * any non-browser client) send none, and the free provider has to keep working
 * there. That is not a hole being left open — a browser cannot suppress its own
 * Origin, so this only ever admits clients that were never subject to CORS in
 * the first place, and they still face the signature and the rate limit.
 */
export function originAllowed(origin, allowedOriginsVar) {
  if (!allowedOriginsVar) return true; // unconfigured: unchanged behaviour
  if (!origin) return true; // native client
  const allowed = allowedOriginsVar
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

/** The CORS headers to answer with. Echoes the caller's origin once a list is configured. */
export function corsHeaders(origin, allowedOriginsVar) {
  return {
    'Access-Control-Allow-Origin': allowedOriginsVar ? (origin ?? '*') : '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-DG-Timestamp, X-DG-Signature',
    'Access-Control-Max-Age': '86400',
    // The answer depends on the request's Origin, so a shared cache must not
    // reuse one origin's response for another.
    Vary: 'Origin',
  };
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verdict on the request's signature.
 *
 * Returns one of 'ok' | 'bad-signature' | 'stale'. An absent signature is 'ok'
 * on purpose: only the Android build is given a secret, so requiring one would
 * cut off every web user of the free provider. A *wrong* one is refused,
 * because the only thing that sends a wrong signature is something that is not
 * our client.
 */
export async function checkSignature(headers, secret, now) {
  if (!secret) return 'ok'; // unconfigured: unchanged behaviour
  const signature = headers.get('X-DG-Signature');
  const timestamp = headers.get('X-DG-Timestamp');
  if (!signature && !timestamp) return 'ok'; // web client, no secret to sign with

  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return 'bad-signature';
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_MS) return 'stale';

  const expected = await hmacHex(secret, timestamp);
  return timingSafeEqualHex(signature, expected) ? 'ok' : 'bad-signature';
}

/**
 * Per-isolate fallback counter.
 *
 * **This is not a global limit.** Cloudflare runs many isolates and each gets
 * its own Map, so the real ceiling is roughly this number times however many
 * isolates are warm — which is why `RATE_LIMITER` exists and this is only what
 * happens when the binding is missing. Kept because losing the binding should
 * degrade the limit, not remove it.
 */
export function createMemoryLimiter(maxPerMinute) {
  const seen = new Map();
  let lastCleanup = 0;
  return function allow(ip, nowMin) {
    if (nowMin - lastCleanup >= 5) {
      lastCleanup = nowMin;
      for (const [k, v] of seen) if (v.minute < nowMin - 1) seen.delete(k);
    }
    const entry = seen.get(ip);
    const count = entry && entry.minute === nowMin ? entry.count : 0;
    if (count >= maxPerMinute) return false;
    seen.set(ip, { minute: nowMin, count: count + 1 });
    return true;
  };
}
