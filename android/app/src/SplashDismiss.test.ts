import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SplashDismiss } from './SplashDismiss';

describe('Android startup splash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="nx-splash"></div>';
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fades and removes the static overlay after the first React commit', () => {
    render(createElement(SplashDismiss));

    expect(document.getElementById('nx-splash')?.classList.contains('nx-splash-loaded')).toBe(true);
    vi.advanceTimersByTime(250);
    expect(document.getElementById('nx-splash')).toBeNull();
  });
});
