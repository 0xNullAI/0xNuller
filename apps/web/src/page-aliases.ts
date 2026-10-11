/**
 * Addresses people type or remember that are not pages of their own. Each maps to the real
 * page it means, so an old link never lands on an untitled inbox.
 */
const PAGE_ALIASES: Record<string, string> = {
  '/contacts': '/people',
  '/friends': '/people',
  '/messages': '/',
  '/inbox': '/',
  '/discover': '/market',
  '/devices': '/control',
  '/device': '/control',
  '/me': '/settings/overview',
};

export function pageAliasFromPath(pathname: string): string | null {
  const normalized = pathname.replace(/\/+$/, '').toLowerCase() || '/';
  return PAGE_ALIASES[normalized] ?? null;
}
