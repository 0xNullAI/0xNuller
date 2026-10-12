import { expect, it } from 'vitest';
import { pageAliasFromPath } from './page-aliases';

it('maps guessed addresses to the real page and leaves real routes alone', () => {
  expect(pageAliasFromPath('/contacts')).toBe('/people');
  expect(pageAliasFromPath('/Contacts/')).toBe('/people');
  expect(pageAliasFromPath('/people')).toBeNull();
  expect(pageAliasFromPath('/')).toBeNull();
  expect(pageAliasFromPath('/legacy-home')).toBeNull();
});
