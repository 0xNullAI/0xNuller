import { expect, it } from 'vitest';
import { listingTagsText } from './character-listing-tags';

it('merges legacy card tags into listing tags without duplicates', () => {
  expect(listingTagsText(['朋友'], ['朋友', '海边'])).toBe('朋友、海边');
});

it('skips card tags that are not valid listing tags', () => {
  expect(listingTagsText([], ['dark fantasy', '长'.repeat(21), '温柔'])).toBe('温柔');
});

it('keeps at most twenty tags', () => {
  const many = Array.from({ length: 25 }, (_, index) => `t${index}`);
  expect(listingTagsText(many.slice(0, 18), many.slice(18)).split('、')).toHaveLength(20);
});
