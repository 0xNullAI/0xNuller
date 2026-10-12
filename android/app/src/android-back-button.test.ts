import { expect, it, vi } from 'vitest';
import type { OnBackButtonPressPayload } from '@tauri-apps/api/app';
import { EXIT_WINDOW_MS, installBackButton } from './android-back-button';

function harness() {
  const handlers: ((payload: OnBackButtonPressPayload) => void)[] = [];
  const unregister = vi.fn(async () => {});
  const register = vi.fn(async (handler: (payload: OnBackButtonPressPayload) => void) => {
    handlers.push(handler);
    return { unregister };
  });
  const scheduled: (() => void)[] = [];
  const deps = {
    register,
    back: vi.fn(),
    notify: vi.fn(),
    schedule: vi.fn((run: () => void, ms: number) => {
      expect(ms).toBe(EXIT_WINDOW_MS);
      scheduled.push(run);
    }),
  };
  return { deps, handlers, unregister, register, scheduled };
}

it('takes one history step when the WebView can go back, without the exit hint', async () => {
  const h = harness();
  await installBackButton(h.deps);
  h.handlers[0]!({ canGoBack: true });
  expect(h.deps.back).toHaveBeenCalledOnce();
  expect(h.deps.notify).not.toHaveBeenCalled();
  expect(h.unregister).not.toHaveBeenCalled();
});

it('at the root hints once, releases the button to Android, then takes it back', async () => {
  const h = harness();
  await installBackButton(h.deps);
  h.handlers[0]!({ canGoBack: false });
  expect(h.deps.notify).toHaveBeenCalledWith('再按一次退出');
  expect(h.unregister).toHaveBeenCalledOnce();
  expect(h.deps.back).not.toHaveBeenCalled();

  h.scheduled[0]!();
  await vi.waitFor(() => expect(h.register).toHaveBeenCalledTimes(2));
  h.handlers[1]!({ canGoBack: true });
  expect(h.deps.back).toHaveBeenCalledOnce();
});

it('leaves Android default back handling in place when registration fails', async () => {
  const notify = vi.fn();
  await expect(
    installBackButton({ register: () => Promise.reject(new Error('no plugin')), notify }),
  ).resolves.toBeUndefined();
  expect(notify).not.toHaveBeenCalled();
});

it('ignores in-app popstate entirely', async () => {
  const h = harness();
  await installBackButton(h.deps);
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(h.deps.notify).not.toHaveBeenCalled();
  expect(h.deps.back).not.toHaveBeenCalled();
});
