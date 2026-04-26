import { describe, it, expect, beforeEach } from 'vitest';
import { isContentModified } from './use-page-content';

describe('isContentModified', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns false when nothing in localStorage', () => {
    expect(isContentModified('agent', 'manual')).toBe(false);
  });

  it('returns true when content has been stored for that key', () => {
    localStorage.setItem('dg-wiki:content:agent/manual', 'edited');
    expect(isContentModified('agent', 'manual')).toBe(true);
  });

  it('keys correctly: project + doc id pair', () => {
    localStorage.setItem('dg-wiki:content:kit/api', 'content');
    expect(isContentModified('kit', 'api')).toBe(true);
    expect(isContentModified('kit', 'overview')).toBe(false);
    expect(isContentModified('agent', 'api')).toBe(false);
  });
});
