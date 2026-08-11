import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  SIGNATURE_WINDOW_MS,
  checkSignature,
  corsHeaders,
  createMemoryLimiter,
  originAllowed,
} from './guard.js';

const SECRET = 'shared-secret';

function sign(timestamp, secret = SECRET) {
  return createHmac('sha256', secret).update(String(timestamp)).digest('hex');
}

function headers(entries) {
  return new Headers(entries);
}

describe('来源限制', () => {
  it('没有配置时不改变现状——任何来源都放行', () => {
    expect(originAllowed('https://evil.example', undefined)).toBe(true);
    expect(originAllowed('https://evil.example', '')).toBe(true);
  });

  it('配置之后只放行名单内的来源', () => {
    const list = 'https://0xnullai.com, http://localhost:5177';
    expect(originAllowed('https://0xnullai.com', list)).toBe(true);
    expect(originAllowed('http://localhost:5177', list)).toBe(true);
    expect(originAllowed('https://evil.example', list)).toBe(false);
  });

  it('没有 Origin 的请求放行——安卓与任何非浏览器客户端都不发这个头', () => {
    expect(originAllowed(null, 'https://0xnullai.com')).toBe(true);
  });

  it('配置之后回显来源，并声明 Vary: Origin', () => {
    const cors = corsHeaders('https://0xnullai.com', 'https://0xnullai.com');
    expect(cors['Access-Control-Allow-Origin']).toBe('https://0xnullai.com');
    expect(cors.Vary).toBe('Origin');
  });

  it('没有配置时仍然是通配符', () => {
    expect(corsHeaders('https://0xnullai.com', undefined)['Access-Control-Allow-Origin']).toBe('*');
  });

  it('允许客户端发出签名头，否则浏览器会在预检就拦下来', () => {
    const allowed = corsHeaders(null, undefined)['Access-Control-Allow-Headers'];
    expect(allowed).toContain('X-DG-Timestamp');
    expect(allowed).toContain('X-DG-Signature');
  });
});

describe('签名校验', () => {
  const now = 1_800_000_000_000;

  it('没有配置密钥时一律放行', async () => {
    const h = headers({ 'X-DG-Signature': 'garbage', 'X-DG-Timestamp': String(now) });
    expect(await checkSignature(h, undefined, now)).toBe('ok');
  });

  it('完全没有签名头的请求放行——网页版没有密钥可签', async () => {
    expect(await checkSignature(headers({}), SECRET, now)).toBe('ok');
  });

  it('签名正确时通过', async () => {
    const h = headers({ 'X-DG-Timestamp': String(now), 'X-DG-Signature': sign(now) });
    expect(await checkSignature(h, SECRET, now)).toBe('ok');
  });

  it('签名错误时拒绝', async () => {
    const h = headers({ 'X-DG-Timestamp': String(now), 'X-DG-Signature': sign(now, 'wrong') });
    expect(await checkSignature(h, SECRET, now)).toBe('bad-signature');
  });

  it('只带其中一个头也算错——半个签名不是没签名', async () => {
    expect(await checkSignature(headers({ 'X-DG-Timestamp': String(now) }), SECRET, now)).toBe(
      'bad-signature',
    );
    expect(await checkSignature(headers({ 'X-DG-Signature': sign(now) }), SECRET, now)).toBe(
      'bad-signature',
    );
  });

  it('时间戳不是数字时拒绝', async () => {
    const h = headers({ 'X-DG-Timestamp': 'now', 'X-DG-Signature': sign('now') });
    expect(await checkSignature(h, SECRET, now)).toBe('bad-signature');
  });

  it('超出时间窗的签名判为过期——录下来的签名不能永久重放', async () => {
    const old = now - SIGNATURE_WINDOW_MS - 1;
    const h = headers({ 'X-DG-Timestamp': String(old), 'X-DG-Signature': sign(old) });
    expect(await checkSignature(h, SECRET, now)).toBe('stale');
  });

  it('时间窗对未来同样成立——设备时钟快了也要挡住', async () => {
    const future = now + SIGNATURE_WINDOW_MS + 1;
    const h = headers({ 'X-DG-Timestamp': String(future), 'X-DG-Signature': sign(future) });
    expect(await checkSignature(h, SECRET, now)).toBe('stale');
  });

  it('窗口边界内仍然接受', async () => {
    const edge = now - SIGNATURE_WINDOW_MS + 1000;
    const h = headers({ 'X-DG-Timestamp': String(edge), 'X-DG-Signature': sign(edge) });
    expect(await checkSignature(h, SECRET, now)).toBe('ok');
  });
});

describe('内存兜底限流', () => {
  it('同一分钟内超过上限就拒绝', () => {
    const allow = createMemoryLimiter(3);
    expect([allow('1.1.1.1', 100), allow('1.1.1.1', 100), allow('1.1.1.1', 100)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(allow('1.1.1.1', 100)).toBe(false);
  });

  it('换一分钟重新计数', () => {
    const allow = createMemoryLimiter(1);
    expect(allow('1.1.1.1', 100)).toBe(true);
    expect(allow('1.1.1.1', 100)).toBe(false);
    expect(allow('1.1.1.1', 101)).toBe(true);
  });

  it('不同 IP 互不影响', () => {
    const allow = createMemoryLimiter(1);
    expect(allow('1.1.1.1', 100)).toBe(true);
    expect(allow('2.2.2.2', 100)).toBe(true);
  });

  it('清理旧记录之后，老 IP 的额度不会被错误保留', () => {
    const allow = createMemoryLimiter(1);
    expect(allow('1.1.1.1', 100)).toBe(true);
    expect(allow('1.1.1.1', 100)).toBe(false);
    // Past the cleanup interval; the stale entry is dropped and the next
    // minute starts from zero rather than inheriting a full bucket.
    expect(allow('1.1.1.1', 106)).toBe(true);
  });
});
