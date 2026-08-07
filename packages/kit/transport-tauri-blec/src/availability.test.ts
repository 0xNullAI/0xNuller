import { afterEach, describe, expect, it } from 'vitest';
import { getTauriBlecAvailability } from './availability.js';

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe('getTauriBlecAvailability', () => {
  it('reports unsupported when window is missing', () => {
    delete (globalThis as { window?: unknown }).window;
    const result = getTauriBlecAvailability();
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/Tauri/);
  });

  it('reports unsupported when window has no __TAURI_INTERNALS__', () => {
    (globalThis as { window?: unknown }).window = {};
    const result = getTauriBlecAvailability();
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/__TAURI_INTERNALS__/);
  });

  it('reports supported when Tauri internals are present', () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    const result = getTauriBlecAvailability();
    expect(result.supported).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
