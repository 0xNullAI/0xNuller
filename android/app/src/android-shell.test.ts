import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncVisualViewport, withConnectPermissionHelp } from './android-shell';

afterEach(() => {
  document.documentElement.removeAttribute('data-keyboard-open');
  document.documentElement.style.removeProperty('--android-viewport-height');
  document.documentElement.style.removeProperty('--android-keyboard-inset');
});

describe('Android shell integration', () => {
  it('keeps prototype device methods while decorating connect', async () => {
    class Client {
      connect = vi.fn(async () => undefined);
      disconnect(): string {
        return 'disconnected';
      }
    }
    const client = new Client();
    const rawConnect = client.connect;
    const wrapped = withConnectPermissionHelp(client);
    await wrapped.connect();
    expect(wrapped).toBe(client);
    expect(wrapped.disconnect()).toBe('disconnected');
    expect(rawConnect).toHaveBeenCalledOnce();
  });

  it('tracks the visual viewport height and keyboard inset', () => {
    const viewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
    };
    viewport.height = 420;
    viewport.offsetTop = 0;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const stop = syncVisualViewport(viewport as VisualViewport);
    expect(document.documentElement.style.getPropertyValue('--android-viewport-height')).toBe(
      '420px',
    );
    expect(document.documentElement.style.getPropertyValue('--android-keyboard-inset')).toBe(
      '380px',
    );
    expect(document.documentElement.hasAttribute('data-keyboard-open')).toBe(true);
    stop();
  });
});
