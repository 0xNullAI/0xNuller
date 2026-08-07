/**
 * Zhipu (bigmodel.cn) API keys are shaped `{id}.{secret}`. Their SDKs sign a
 * short-lived HS256 JWT client-side from that pair rather than sending the
 * raw key over the wire — this is the same scheme their chat-completions
 * SDKs use, applied here to the realtime WS's `?Authorization=` query param
 * so DG-Voice never needs a server-side round trip for this provider.
 */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export async function signZhipuJwt(apiKey: string, expireSeconds = 3600): Promise<string> {
  const separatorIndex = apiKey.indexOf('.');
  if (separatorIndex <= 0) {
    throw new Error('智谱 API 密钥格式应为 {id}.{secret}');
  }
  const id = apiKey.slice(0, separatorIndex);
  const secret = apiKey.slice(separatorIndex + 1);

  const now = Date.now();
  // Field order matches Zhipu's official SDK's PyJWT output exactly
  // ({alg, typ, sign_type}) so a token we sign is byte-identical to what
  // their own examples produce for the same inputs. `typ: 'JWT'` in
  // particular is PyJWT's default and was missing before; a validator that
  // requires it would reject a token without it. (Signature validity itself
  // doesn't depend on this — the server recomputes HMAC over whatever bytes
  // we send — but matching the reference removes it as a variable while the
  // provider is still unverified against a real key.)
  const header = { alg: 'HS256', typ: 'JWT', sign_type: 'SIGN' };
  const payload = { api_key: id, exp: now + expireSeconds * 1000, timestamp: now };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}
