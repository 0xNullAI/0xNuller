import { describe, expect, it } from 'vitest';
import { decodeContentCursor, encodeContentCursor } from './content-cursor';

describe('content sync cursor', () => {
  it('round-trips a URL-safe opaque cursor', () => {
    const cursor = encodeContentCursor({ updatedAt: 1_725_000_000_123, id: 'session:item-1' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeContentCursor(cursor)).toEqual({
      updatedAt: 1_725_000_000_123,
      id: 'session:item-1',
    });
  });

  it('rejects malformed, negative, fractional, and wrongly shaped cursors', () => {
    expect(decodeContentCursor(null)).toBeNull();
    expect(decodeContentCursor('not+url/safe')).toBeNull();
    for (const value of [[-1, 'id'], [1.5, 'id'], [1], [1, 2]]) {
      const encoded = btoa(JSON.stringify(value)).replace(/=+$/, '');
      expect(decodeContentCursor(encoded)).toBeNull();
    }
  });
});
