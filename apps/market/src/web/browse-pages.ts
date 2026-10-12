import type { MarketItem } from '../shared/schema';

export const MARKET_PAGE_SIZE = 50;

export function appendBrowsePage(previous: MarketItem[], page: MarketItem[]): MarketItem[] {
  const seen = new Set(previous.map((item) => item.id));
  return [...previous, ...page.filter((item) => !seen.has(item.id))];
}
