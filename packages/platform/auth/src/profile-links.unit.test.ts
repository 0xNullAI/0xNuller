import { expect, it } from 'vitest';
import { normalizeProfileLink, safeProfileLinks } from './profile-links';

it('accepts web links and rejects executable or credential-bearing profile links', () => {
  expect(normalizeProfileLink(' https://example.com/about ')).toBe('https://example.com/about');
  expect(normalizeProfileLink('http://example.com')).toBe('http://example.com/');
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,hello',
    '//example.com',
    'https://user:password@example.com/',
    'not a url',
  ])
    expect(normalizeProfileLink(value)).toBeNull();
  expect(safeProfileLinks(['javascript:alert(1)', 'https://example.com'])).toEqual([
    'https://example.com/',
  ]);
});
