import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ModuleErrorBoundary } from './ModuleErrorBoundary';
const stop = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@0xnullai/ui', () => ({ stopAllDevices: () => stop.run() }));
function Crash(): never {
  throw new Error('test failure');
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it.each([true, false])('only claims stopped after the result (%s)', async (confirmed) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let finish!: (ok: boolean) => void;
  stop.run.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  render(
    <ModuleErrorBoundary moduleId="test" label="测试">
      <Crash />
    </ModuleErrorBoundary>,
  );
  expect(screen.getByText('已请求停止，正在确认…')).toBeTruthy();
  expect(screen.queryByText(/已确认停止/)).toBeNull();
  await act(async () => finish(confirmed));
  expect(
    screen.getByText(
      confirmed ? '模块发生错误，设备已确认停止' : '未确认设备停止，请使用紧急停止或手动关闭设备',
    ),
  ).toBeTruthy();
});

it('keeps stale-chunk reload unavailable while stop is pending and exposes failure', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let finish!: (ok: boolean) => void;
  stop.run.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  function Stale(): never {
    throw new Error('Failed to fetch dynamically imported module');
  }
  render(
    <ModuleErrorBoundary moduleId="test" label="测试">
      <Stale />
    </ModuleErrorBoundary>,
  );
  expect((screen.getByRole('button', { name: '重新加载' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => finish(false));
  expect(screen.getByText('未确认设备停止，请使用紧急停止或手动关闭设备')).toBeTruthy();
});
