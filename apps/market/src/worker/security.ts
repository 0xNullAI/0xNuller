export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare arbitrary secrets without leaking a shared prefix or their original lengths. */
export async function secretEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  // Node's Web Crypto still lacks the Workers extension used in production. The
  // fallback compares fixed-size digests and exists for local tooling/tests only.
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

export async function hashSourceIp(ip: string, pepper: string): Promise<string> {
  return (await sha256Hex(`${ip}:${pepper}`)).slice(0, 32);
}

export function hashLegacyEditKey(key: string, adminKey: string): Promise<string> {
  return sha256Hex(`${key}:${adminKey}`);
}

export function hashCurrentEditKey(key: string, editPepper: string): Promise<string> {
  return sha256Hex(`${key}:${editPepper}`);
}
