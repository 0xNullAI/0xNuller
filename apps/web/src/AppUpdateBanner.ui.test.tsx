import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppUpdateBanner } from './AppUpdateBanner';
import { markAppUpdated, resetAppUpdateForTests, stopThenReload } from './app-update';

const stop = vi.hoisted(() => ({ run: vi.fn<() => Promise<boolean>>() }));
vi.mock('@0xnullai/ui', () => ({ stopAllDevices: () => stop.run() }));

afterEach(() => {
  cleanup();
  resetAppUpdateForTests();
  stop.run.mockReset();
});

it('offers a reload instead of reloading when the build is outdated', () => {
  render(<AppUpdateBanner />);
  expect(screen.queryByRole('status')).toBeNull();
  act(() => markAppUpdated());
  expect(screen.getByRole('button', { name: /重新加载/ })).toBeTruthy();
  expect(stop.run).not.toHaveBeenCalled();
});

it('stops every device first and reloads only after the stop is confirmed', async () => {
  let finish!: (ok: boolean) => void;
  stop.run.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  const reload = vi.fn();
  render(<AppUpdateBanner />);
  act(() => markAppUpdated());

  let result!: Promise<boolean>;
  await act(async () => {
    result = stopThenReload(reload);
  });
  expect(stop.run).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: /正在停止设备/ }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  await act(async () => finish(true));
  expect(await result).toBe(true);
  expect(reload).toHaveBeenCalledOnce();
});

it('keeps the page when a device did not confirm the stop', async () => {
  stop.run.mockResolvedValue(false);
  const reload = vi.fn();
  render(<AppUpdateBanner />);
  act(() => markAppUpdated());
  await act(async () => {
    await stopThenReload(reload);
  });
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByText(/设备未确认停止/)).toBeTruthy();
  // The person can try again once the device is dealt with.
  stop.run.mockResolvedValue(true);
  const reloadButton = screen.getByRole('button', { name: /重新加载/ });
  expect((reloadButton as HTMLButtonElement).disabled).toBe(false);
});

it('the bootstrap listener does not cancel the failed import', async () => {
  // Not prevented: the page that failed still reaches its ModuleErrorBoundary,
  // which stops devices on catch.
  const event = new Event('vite:preloadError', { cancelable: true });
  window.addEventListener('vite:preloadError', markAppUpdated);
  try {
    window.dispatchEvent(event);
  } finally {
    window.removeEventListener('vite:preloadError', markAppUpdated);
  }
  expect(event.defaultPrevented).toBe(false);
  stop.run.mockResolvedValue(false);
  render(<AppUpdateBanner />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /重新加载/ }));
  });
  expect(stop.run).toHaveBeenCalledOnce();
});
