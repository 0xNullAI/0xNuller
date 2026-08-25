/**
 * Read a session token from either supported carrier:
 * - Cookie for same-site web modules.
 * - Bearer for the Android WebView, which cannot use the web domain's cookie.
 */
export function readToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  const cookie = request.headers.get('Cookie') ?? '';
  const match = /(?:^|;\s*)0xn_session=([^;]+)/.exec(cookie);
  return match?.[1] ?? null;
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  // Domain spans the subdomains so all product modules share one login state.
  // SameSite=Lax still prevents cross-site requests from carrying the cookie.
  return [
    `0xn_session=${token}`,
    'Path=/',
    'Domain=.0xnullai.com',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ].join('; ');
}
