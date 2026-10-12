export type MarketEditorRoute =
  | { kind: 'new'; cardKind?: 'character' | 'scene' }
  | { kind: 'edit'; itemId: string }
  | { kind: 'invalid' };

const ITEM_ID = /^[\w-]{1,128}$/;

export function marketEditorRoute(search: string): MarketEditorRoute | null {
  const params = new URLSearchParams(search);
  const editor = params.get('editor');
  if (editor === null) return null;
  if (params.getAll('editor').length !== 1) return { kind: 'invalid' };
  if (editor === 'new') {
    const cardKind = params.get('kind');
    if (params.has('template')) return { kind: 'invalid' };
    if (
      params.getAll('kind').length > 1 ||
      (cardKind && cardKind !== 'character' && cardKind !== 'scene')
    )
      return { kind: 'invalid' };
    return {
      kind: 'new',
      ...(cardKind === 'character' || cardKind === 'scene' ? { cardKind } : {}),
    };
  }
  if (params.has('template') || params.has('kind') || !ITEM_ID.test(editor))
    return { kind: 'invalid' };
  return { kind: 'edit', itemId: editor };
}

export function marketEditorHref(
  href: string,
  route: Exclude<MarketEditorRoute, { kind: 'invalid' }> | null,
  publishedItemId?: string,
): string {
  const url = new URL(href);
  url.searchParams.delete('editor');
  url.searchParams.delete('template');
  url.searchParams.delete('kind');
  url.searchParams.delete('item');
  if (route?.kind === 'new') {
    url.searchParams.set('editor', 'new');
    if (route.cardKind) url.searchParams.set('kind', route.cardKind);
  } else if (route?.kind === 'edit') {
    url.searchParams.set('editor', route.itemId);
  } else if (publishedItemId) {
    url.searchParams.set('item', publishedItemId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
