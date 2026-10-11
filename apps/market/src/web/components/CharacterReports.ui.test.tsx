// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CharacterModeration, CharacterReportAction } from './CharacterReports';
const mocks = vi.hoisted(() => ({
  account: 'alice' as string | null,
  listeners: new Set<() => void>(),
  me: vi.fn(),
  report: vi.fn(),
  queue: vi.fn(),
  resolve: vi.fn(),
  conversions: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => mocks.account,
  subscribeAuthChanges: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
  me: mocks.me,
}));
vi.mock('../api', () => ({
  reportCharacter: mocks.report,
  fetchCharacterReports: mocks.queue,
  resolveCharacterReport: mocks.resolve,
  fetchCharacterConversions: mocks.conversions,
}));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.account = 'alice';
  mocks.me.mockResolvedValue({ id: 'alice', role: 'user' });
  mocks.report.mockResolvedValue({ ok: true });
  mocks.resolve.mockResolvedValue({ ok: true });
  mocks.queue.mockResolvedValue({ items: [], nextOffset: null });
  mocks.conversions.mockResolvedValue({ windowDays: 30, items: [] });
});
it('requires login, submits only a chosen reason, and resets private state on account switch', async () => {
  render(<CharacterReportAction itemId="card" />);
  fireEvent.click(screen.getByText('举报角色'));
  fireEvent.change(screen.getByLabelText('举报理由'), { target: { value: 'privacy' } });
  fireEvent.click(screen.getByText('提交举报'));
  await screen.findByText('举报已提交');
  expect(mocks.report).toHaveBeenCalledExactlyOnceWith('card', 'privacy');
  act(() => {
    mocks.account = null;
    mocks.listeners.forEach((listener) => listener());
  });
  expect(screen.queryByText('举报已提交')).toBeNull();
  fireEvent.click(screen.getByText('举报角色'));
  expect((screen.getByText('请先登录后举报') as HTMLButtonElement).disabled).toBe(true);
});
it('hides the moderation entry for ordinary accounts', async () => {
  render(<CharacterModeration onChanged={vi.fn()} />);
  await waitFor(() => expect(mocks.me).toHaveBeenCalled());
  expect(screen.queryByText('举报审核')).toBeNull();
  expect(mocks.queue).not.toHaveBeenCalled();
  expect(screen.queryByText('角色入口指标')).toBeNull();
});
it('shows only aggregate conversion metrics to admins', async () => {
  mocks.me.mockResolvedValue({ id: 'alice', role: 'admin' });
  mocks.conversions.mockResolvedValue({
    windowDays: 30,
    items: [{ itemId: 'card', itemName: '公开角色', openedAccounts: 8, startedAccounts: 3 }],
  });
  render(<CharacterModeration onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '角色入口指标' }));
  expect(await screen.findByText('公开角色 · 打开 8 账户 · 开始 3 账户')).toBeTruthy();
  expect(mocks.conversions).toHaveBeenCalledOnce();
});
it('shows admin queue, preserves errors for retry, then hides and refreshes', async () => {
  mocks.me.mockResolvedValue({ id: 'alice', role: 'admin' });
  const row = {
    id: 'r1',
    itemId: 'card',
    itemName: '公开角色',
    reason: 'privacy',
    createdAt: 1,
    hidden: 0,
  };
  mocks.queue.mockResolvedValueOnce({ items: [row], nextOffset: null });
  mocks.resolve.mockRejectedValueOnce(new Error('网络失败'));
  const changed = vi.fn();
  render(<CharacterModeration onChanged={changed} />);
  fireEvent.click(await screen.findByText('举报审核'));
  await screen.findByText('公开角色');
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByText('隐藏角色并结案'));
  await screen.findByText('网络失败');
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('隐藏角色并结案'));
  await screen.findByText('暂无待处理举报');
  expect(mocks.resolve).toHaveBeenLastCalledWith('r1', 'hide');
  expect(changed).toHaveBeenCalledTimes(1);
  act(() => {
    mocks.account = 'bob';
    mocks.listeners.forEach((listener) => listener());
  });
  expect(screen.queryByRole('dialog')).toBeNull();
});
