import { afterEach, describe, expect, it } from 'vitest';
import { installAndroidPolyfills } from './polyfills';

const original = Object.getOwnPropertyDescriptor(Object, 'hasOwn');

afterEach(() => {
  if (original) Object.defineProperty(Object, 'hasOwn', original);
});

describe('Android runtime polyfills', () => {
  it('provides Object.hasOwn for WebView 92', () => {
    Object.defineProperty(Object, 'hasOwn', { configurable: true, value: undefined });
    installAndroidPolyfills();

    expect(Object.hasOwn({ own: true }, 'own')).toBe(true);
    expect(Object.hasOwn(Object.create({ inherited: true }), 'inherited')).toBe(false);
  });
});
