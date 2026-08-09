/**
 * Password hashing.
 *
 * The Workers runtime only has WebCrypto — no Argon2id / scrypt / bcrypt. The best
 * available choice is PBKDF2-SHA256 at 210,000 iterations, per current OWASP
 * guidance. This is weaker than Argon2id — far less resistant to GPUs and ASICs —
 * but there is no better native option in this runtime, and pulling in a WASM build
 * of Argon2 would add considerable cold-start and CPU time to a Worker on the free
 * tier.
 *
 * This trade-off has to be remembered: if the database ever leaks, offline cracking
 * of PBKDF2 costs far less than Argon2id. The mitigations live elsewhere — an
 * enforced minimum password length, login rate limiting, and most importantly
 * **an account can never obtain device control from a login alone**, so the payoff
 * from a stolen account is inherently limited.
 *
 * Storage format: `pbkdf2$<iterations>$<base64 salt>$<base64 derived key>`
 * The iteration count is written into the string so that when it is raised later,
 * old hashes still verify and are silently upgraded on the next successful login.
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
  /**
   * True when the stored iteration count is below the current standard; the caller
   * should re-hash after a successful login.
   */
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

/**
 * Constant-time compare. Accumulates the difference with bitwise OR and never
 * returns early — otherwise the comparison time would leak the password prefix.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
