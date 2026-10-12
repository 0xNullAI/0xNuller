import { describe, expect, it } from 'vitest';
import {
  clientErrorSignatureSource,
  parseClientErrorReport,
  redactSensitiveText,
  sanitizeErrorMessage,
  sanitizeRoute,
  sanitizeStack,
  stripUrlQueries,
  topStackFrame,
} from './client-errors';

const VALID = {
  kind: 'error',
  message: 'TypeError: x is not a function',
  stack: null,
  moduleId: 'agent',
  platform: 'web',
  version: '6.5.7',
  buildId: 'abc123',
  route: '/agent',
  occurredAt: 1_700_000_000_000,
  sessionId: '0f8c7a5e-1111-4222-8333-944445555666',
};

describe('client error sanitizer', () => {
  it('strips query strings and fragments from every URL', () => {
    expect(
      stripUrlQueries(
        'failed https://0xnullai.com/api/auth/me?token=abc#x and wss://0xnullai.com/ws/room/a?ticket=t',
      ),
    ).toBe('failed https://0xnullai.com/api/auth/me and wss://0xnullai.com/ws/room/a');
  });

  it('removes tokens, keys, emails, ids and phone numbers', () => {
    const text = redactSensitiveText(
      [
        'Authorization: Bearer abc.def.ghi',
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
        'api_key=sk-live-1234567890abcdef',
        '{"password":"hunter2"}',
        'user alice@example.com',
        'id 0f8c7a5e-1111-4222-8333-944445555666',
        'phone 13800138000',
        'opaque a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7',
      ].join('\n'),
    );
    for (const secret of [
      'abc.def.ghi',
      'eyJhbGci',
      'sk-live',
      'hunter2',
      'alice@example.com',
      '0f8c7a5e',
      '13800138000',
      'a1B2c3D4e5F6',
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('[email]');
  });

  it('drops long quoted or Chinese text that is likely user content', () => {
    expect(
      sanitizeErrorMessage(
        'Unexpected token in JSON at "我今天想和你说一些很私密的话，请不要告诉别人好吗"',
      ),
    ).not.toContain('私密');
    expect(
      sanitizeErrorMessage('解析失败：我今天想和你说一些很私密的话请不要告诉别人好吗谢谢你'),
    ).not.toContain('私密');
    expect(sanitizeErrorMessage('请求失败（500）')).toBe('请求失败（500）');
  });

  it('bounds message and stack length and frame count', () => {
    expect(sanitizeErrorMessage('x'.repeat(5000)).length).toBeLessThanOrEqual(300);
    const stack = [
      'Error: boom',
      ...Array.from(
        { length: 50 },
        (_, i) => `    at f${i} (https://0xnullai.com/a.js?v=1:1:${i})`,
      ),
    ].join('\n');
    const clean = sanitizeStack(stack)!;
    expect(clean.split('\n')).toHaveLength(13);
    expect(clean).not.toContain('?v=1');
  });

  it('keeps only non-identifying route segments', () => {
    expect(sanitizeRoute('/u/alice?tab=1#x')).toBe('/u/:param');
    expect(sanitizeRoute('/settings/overview')).toBe('/settings/overview');
    expect(sanitizeRoute('/chat/room/ABC123/extra')).toBe('/chat/:param/:param');
    expect(sanitizeRoute('/')).toBe('/');
  });

  it('derives the same signature across builds and line numbers', () => {
    const a = 'TypeError: a\n    at render (https://0xnullai.com/assets/index-AbC12345.js:1:2345)';
    const b = 'TypeError: a\n    at render (https://0xnullai.com/assets/index-ZzY98765.js:1:999)';
    expect(topStackFrame(a)).toBe('render /assets/index.js');
    expect(topStackFrame('render@https://0xnullai.com/assets/x.js:3:4')).toBe(
      'render /assets/x.js',
    );
    expect(clientErrorSignatureSource('Failed 12 times', a)).toBe(
      clientErrorSignatureSource('Failed 99 times', b),
    );
  });
});

describe('parseClientErrorReport', () => {
  it('accepts a valid report and re-sanitizes it', () => {
    const parsed = parseClientErrorReport({
      ...VALID,
      message: 'boom https://x.test/p?token=1 bob@example.com',
      route: '/u/bob?x=1',
      extra: 'dropped',
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.message).toBe('boom https://x.test/p [email]');
    expect(parsed!.route).toBe('/u/:param');
    expect(parsed).not.toHaveProperty('extra');
  });

  it.each([
    ['kind', 'fatal'],
    ['platform', 'ios'],
    ['message', ''],
    ['moduleId', '../etc'],
    ['version', 'x'.repeat(40)],
    ['buildId', 'a b'],
    ['occurredAt', 'now'],
    ['sessionId', 'short'],
    ['stack', 42],
  ])('rejects an invalid %s', (field, value) => {
    expect(parseClientErrorReport({ ...VALID, [field]: value })).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(parseClientErrorReport(null)).toBeNull();
    expect(parseClientErrorReport([VALID])).toBeNull();
  });
});
