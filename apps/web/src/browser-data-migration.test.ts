import { describe, expect, it } from 'vitest';
import { mergeLegacyLocalValue } from './browser-data-migration';

describe('legacy browser data merge', () => {
  it('does not overwrite an existing scalar setting', () => {
    expect(mergeLegacyLocalValue('dg-chat-name', 'new', 'old')).toBe('new');
    expect(mergeLegacyLocalValue('dg-chat-name', null, 'old')).toBe('old');
  });

  it('merges groups by room code with the current origin taking precedence', () => {
    const current = JSON.stringify([{ code: 'same', name: 'Current' }]);
    const legacy = JSON.stringify([
      { code: 'same', name: 'Legacy' },
      { code: 'old-only', name: 'Old only' },
    ]);
    expect(JSON.parse(mergeLegacyLocalValue('dg-chat-groups', current, legacy)!)).toEqual([
      { code: 'same', name: 'Current' },
      { code: 'old-only', name: 'Old only' },
    ]);
  });

  it('keeps the latest direct-message read timestamp', () => {
    const current = JSON.stringify({ roomA: 20, roomB: 5 });
    const legacy = JSON.stringify({ roomA: 10, roomB: 30, roomC: 4 });
    expect(JSON.parse(mergeLegacyLocalValue('dg-chat-dm-read', current, legacy)!)).toEqual({
      roomA: 20,
      roomB: 30,
      roomC: 4,
    });
  });

  it('ignores malformed structured legacy values when current data exists', () => {
    expect(mergeLegacyLocalValue('dg-chat-groups', '[]', 'not-json')).toBe('[]');
  });
});
