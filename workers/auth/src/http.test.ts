import { describe, expect, it } from 'vitest';
import { corsHeaders, err, json, readBodyBounded } from './http';

describe('HTTP response helpers', () => {
  it('keeps the existing JSON envelope, status, and caller headers', async () => {
    const response = json({ ok: true }, 201, { 'X-Request-Id': 'request-1' });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-request-id')).toBe('request-1');
    expect(await response.json()).toEqual({ ok: true });

    const failure = err('bad input', 400);
    expect(failure.status).toBe(400);
    expect(await failure.json()).toEqual({ error: 'bad input' });
  });

  it('only enables credentialed CORS for an explicitly allowed origin', () => {
    const allowed = new Request('https://auth.0xnullai.com/api/auth/me', {
      headers: { Origin: 'https://app.0xnullai.com' },
    });
    expect(corsHeaders(allowed, ' https://0xnullai.com, https://app.0xnullai.com ')).toMatchObject({
      'Access-Control-Allow-Origin': 'https://app.0xnullai.com',
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    });

    const denied = new Request('https://auth.0xnullai.com/api/auth/me', {
      headers: { Origin: 'https://attacker.example' },
    });
    expect(corsHeaders(denied, 'https://0xnullai.com')).toEqual({});
  });
});

describe('bounded request bodies', () => {
  it('returns the complete body at the exact limit', async () => {
    const body = await readBodyBounded(
      new Request('https://auth.0xnullai.com/photo', { method: 'PUT', body: '1234' }),
      4,
    );
    expect(new TextDecoder().decode(body!)).toBe('1234');
  });

  it('rejects declared and streamed bodies above the limit', async () => {
    const declared = new Request('https://auth.0xnullai.com/photo', {
      method: 'PUT',
      headers: { 'content-length': '5' },
      body: '1234',
    });
    expect(await readBodyBounded(declared, 4)).toBeNull();

    const streamed = new Request('https://auth.0xnullai.com/photo', {
      method: 'PUT',
      body: '12345',
    });
    expect(await readBodyBounded(streamed, 4)).toBeNull();
  });

  it('accepts a request without a body as empty', async () => {
    expect(
      (await readBodyBounded(new Request('https://auth.0xnullai.com/me'), 4))?.byteLength,
    ).toBe(0);
  });
});
