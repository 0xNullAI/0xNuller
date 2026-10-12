import { expect, it } from 'vitest';
import { marketEditorHref, marketEditorRoute } from './market-editor-route';

it('parses explicit character or scene editors and rejects retired templates', () => {
  expect(marketEditorRoute('?editor=new&kind=scene')).toEqual({
    kind: 'new',
    cardKind: 'scene',
  });
  expect(marketEditorRoute('?editor=new&template=companion-lan')).toEqual({ kind: 'invalid' });
  expect(marketEditorRoute('?editor=card-1')).toEqual({ kind: 'edit', itemId: 'card-1' });
  expect(marketEditorRoute('?item=card-1')).toBeNull();
  expect(marketEditorRoute('?editor=new&editor=card-1')).toEqual({ kind: 'invalid' });
  expect(marketEditorRoute('?editor=../private')).toEqual({ kind: 'invalid' });
  expect(marketEditorRoute('?editor=card-1&template=companion-lan')).toEqual({ kind: 'invalid' });
});

it('uses one Market route for edit, new prompt cards, and published detail', () => {
  expect(
    marketEditorHref('https://example.test/market?item=old#top', {
      kind: 'new',
      cardKind: 'scene',
    }),
  ).toBe('/market?editor=new&kind=scene#top');
  expect(
    marketEditorHref('https://example.test/market?editor=old&template=stale', {
      kind: 'edit',
      itemId: 'card-1',
    }),
  ).toBe('/market?editor=card-1');
  expect(marketEditorHref('https://example.test/market?editor=new', null, 'card-1')).toBe(
    '/market?item=card-1',
  );
});
