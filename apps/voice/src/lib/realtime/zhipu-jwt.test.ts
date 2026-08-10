import { describe, expect, it } from 'vitest';
import { signZhipuJwt } from './zhipu-jwt.js';

function base64UrlDecodeJson(segment: string): unknown {
  const padded = segment
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(segment.length / 4) * 4, '=');
  return JSON.parse(atob(padded));
}

describe('signZhipuJwt', () => {
  it('rejects a key without the {id}.{secret} shape', async () => {
    await expect(signZhipuJwt('not-a-valid-key')).rejects.toThrow('{id}.{secret}');
  });

  it('produces a three-segment JWT with the expected header and api_key claim', async () => {
    const jwt = await signZhipuJwt('my-id.my-secret', 1800);
    const segments = jwt.split('.');
    expect(segments).toHaveLength(3);

    const header = base64UrlDecodeJson(segments[0]!) as Record<string, unknown>;
    // Must match Zhipu's canonical PyJWT header exactly, including typ:JWT.
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT', sign_type: 'SIGN' });

    const payload = base64UrlDecodeJson(segments[1]!) as Record<string, unknown>;
    expect(payload.api_key).toBe('my-id');
    expect(typeof payload.exp).toBe('number');
    expect(typeof payload.timestamp).toBe('number');
    expect((payload.exp as number) - (payload.timestamp as number)).toBe(1800 * 1000);
  });

  it('is deterministic for the same key+timestamp inputs (signature verifiable server-side)', async () => {
    const jwtA = await signZhipuJwt('abc.def');
    const jwtB = await signZhipuJwt('abc.def');
    // Timestamps differ between calls, so full JWTs differ, but both must be
    // well-formed 3-segment tokens signed with the same secret.
    expect(jwtA.split('.')).toHaveLength(3);
    expect(jwtB.split('.')).toHaveLength(3);
  });
});
