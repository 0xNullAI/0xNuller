import { createElement } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
  invoke: vi.fn(),
  lease: vi.fn(),
  stop: vi.fn(),
  failure: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    mocks.handlers.set(name, handler);
    return () => mocks.handlers.delete(name);
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@dg-kit/safety', () => ({ grantDeviceLease: mocks.lease }));
vi.mock('@0xnullai/ui', () => ({ stopAllDevices: mocks.stop, reportStopFailure: mocks.failure }));
import { DesktopLifecycle } from './DesktopLifecycle';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.lease.mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValue(undefined);
});
afterEach(cleanup);
it('keeps the window open when stopping is unconfirmed, and permits a later confirmed retry', async () => {
  mocks.stop.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(createElement(DesktopLifecycle));
  await act(async () => {
    mocks.handlers.get('app://close-requested')!();
  });
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.lease).toHaveBeenCalledWith(null);
  await act(async () => {
    mocks.handlers.get('app://close-requested')!();
  });
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('desktop_finish_exit'));
});
it('coalesces repeated close events until stop is acknowledged', async () => {
  let finish!: (value: boolean) => void;
  mocks.stop.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  render(createElement(DesktopLifecycle));
  await act(async () => {
    mocks.handlers.get('app://close-requested')!();
    mocks.handlers.get('app://close-requested')!();
  });
  expect(mocks.stop).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).not.toHaveBeenCalled();
  await act(async () => finish(true));
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
