/**
 * 密码哈希。
 *
 * Workers 运行时只有 WebCrypto，没有 Argon2id / scrypt / bcrypt。可用的最好选择是
 * PBKDF2-SHA256，按 OWASP 现行建议取 210,000 轮。这比 Argon2id 弱——它对 GPU 与
 * ASIC 的抵抗力差得多——但在这个运行时里没有更好的原生选项，而引入 WASM 版 Argon2
 * 会给一个免费额度的 Worker 增加可观的冷启动与 CPU 时间。
 *
 * 这个取舍必须被记住：如果哪天库泄露了，PBKDF2 的离线爆破成本远低于 Argon2id。
 * 缓解手段是别处的——强制最小密码长度、登录限流、以及最重要的一条：**账号永远
 * 不能仅凭登录态获得设备控制权**，所以盗号的收益本身就是有限的。
 *
 * 存储格式：`pbkdf2$<轮数>$<base64 盐>$<base64 派生密钥>`
 * 轮数写进字符串，将来提高轮数时老密码仍可验证，并在下次登录成功时静默升级。
 */

const ITERATIONS = 210_000;
const KEY_LEN = 32;
const SALT_LEN = 16;

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEY_LEN * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const dk = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(dk)}`;
}

export interface VerifyResult {
  ok: boolean;
  /** 存储用的轮数低于当前标准时为 true，调用方应在登录成功后重新哈希。 */
  needsUpgrade: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return { ok: false, needsUpgrade: false };
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return { ok: false, needsUpgrade: false };

  const salt = unb64(parts[2]!);
  const expected = unb64(parts[3]!);
  const actual = await derive(password, salt, iterations);
  return { ok: timingSafeEqual(actual, expected), needsUpgrade: iterations < ITERATIONS };
}

/** 定长比较。用按位或累积差异，不提前返回——避免用比较耗时反推密码前缀。 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
