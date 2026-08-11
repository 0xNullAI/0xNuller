export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashSourceIp(ip: string, pepper: string): Promise<string> {
  return (await sha256Hex(`${ip}:${pepper}`)).slice(0, 32);
}
