// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { loadThemeMode, setThemeMode } from './theme-store';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it('opens dark when nothing was saved', () => {
  expect(loadThemeMode()).toBe('dark');
});

it('keeps an explicit light or follow-system choice', () => {
  localStorage.setItem('0xnullai.theme', 'light');
  expect(loadThemeMode()).toBe('light');
  localStorage.setItem('0xnullai.theme', 'auto');
  expect(loadThemeMode()).toBe('auto');
});

it('migrates a pre-merge module choice instead of overriding it with the default', () => {
  localStorage.setItem('dg-market.theme', 'light');
  expect(loadThemeMode()).toBe('light');
  expect(localStorage.getItem('0xnullai.theme')).toBe('light');
});

it('falls back to dark when storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(loadThemeMode()).toBe('dark');
});

it('applies and persists a chosen mode', () => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  setThemeMode('light');
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  expect(localStorage.getItem('0xnullai.theme')).toBe('light');
  vi.unstubAllGlobals();
});
