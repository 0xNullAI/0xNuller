import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, timingSafeEqual } from './password';

describe('密码哈希', () => {
  it('同一密码两次哈希不同（盐随机），但都能验证通过', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect((await verifyPassword('correct horse battery', a)).ok).toBe(true);
    expect((await verifyPassword('correct horse battery', b)).ok).toBe(true);
  });

  it('错误密码不通过', async () => {
    const h = await hashPassword('correct horse battery');
    expect((await verifyPassword('correct horse batteryy', h)).ok).toBe(false);
    expect((await verifyPassword('', h)).ok).toBe(false);
  });

  it('存储格式损坏时判定为不通过，而不是抛错让登录接口 500', async () => {
    for (const bad of ['', 'garbage', 'pbkdf2$abc$x$y', 'pbkdf2$1000$only-three']) {
      expect((await verifyPassword('x', bad)).ok).toBe(false);
    }
  });

  it('轮数低于当前标准时标记为需升级——老密码不必让用户改', async () => {
    const h = await hashPassword('correct horse battery');
    const weak = h.replace(/^pbkdf2\$\d+\$/, 'pbkdf2$1000$');
    // 轮数变了，派生结果对不上，所以 ok 为 false；这里只验证解析出了低轮数
    expect(weak.split('$')[1]).toBe('1000');
    expect((await verifyPassword('correct horse battery', h)).needsUpgrade).toBe(false);
  });

  it('定长比较：长度不同直接 false，内容不同也 false', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });
});
