import { expect, it, vi } from 'vitest';
import { publicCharacterLink, publicCharacterShare } from './public-character-share';
vi.mock('@0xnullai/market-client', () => ({ marketBaseUrl: () => '' }));
it('shares only a public card name and reference and never permits arbitrary URLs', () => {
  const text = publicCharacterShare('card-1', '公\n开');
  expect(text).toBe('公开角色卡：公 开\n/market?item=card-1');
  expect(publicCharacterLink(text)).toBe('/market?item=card-1');
  expect(publicCharacterLink('公开角色卡：X\nhttps://evil.test')).toBeNull();
  expect(() => publicCharacterShare('../private', 'X')).toThrow();
});
