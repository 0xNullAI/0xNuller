import { describe, expect, it } from 'vitest';
import { shouldNotify, totalUnread, unreadTitle } from './unread-messages';

describe('unread messages', () => {
  it('adds only known positive counts', () => {
    expect(totalUnread([2, null, 0, undefined, 3])).toBe(5);
  });

  it('shows the count in the tab title and caps it', () => {
    expect(unreadTitle(0)).toBe('0xNuller');
    expect(unreadTitle(3)).toBe('(3) 0xNuller');
    expect(unreadTitle(150)).toBe('(99+) 0xNuller');
  });

  it('notifies only for a rise while hidden, opted in and permitted', () => {
    const base = {
      previous: 1,
      current: 2,
      hidden: true,
      enabled: true,
      permission: 'granted' as const,
    };
    expect(shouldNotify(base)).toBe(true);
    expect(shouldNotify({ ...base, previous: null })).toBe(false);
    expect(shouldNotify({ ...base, current: 1 })).toBe(false);
    expect(shouldNotify({ ...base, hidden: false })).toBe(false);
    expect(shouldNotify({ ...base, enabled: false })).toBe(false);
    expect(shouldNotify({ ...base, permission: 'default' })).toBe(false);
  });
});
