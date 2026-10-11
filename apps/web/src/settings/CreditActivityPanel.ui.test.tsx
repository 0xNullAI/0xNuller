// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreditActivityPanel } from './CreditActivityPanel';
const api = vi.hoisted(() => ({ getCreditActivity: vi.fn() }));
vi.mock('@0xnullai/auth', () => api);
vi.mock('@0xnullai/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
const base = {
  id: 'r:usage',
  kind: 'usage',
  referenceId: 'usage',
  priceVersion: null,
  createdAt: 1,
  model: 'balanced',
  durationMs: null,
  reservedCredits: 20,
  chargedCredits: null,
  conversationId: null,
  relationshipId: null,
  taskId: null,
  scheduleId: null,
  taskState: null,
  recoveryState: null,
  anomaly: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  api.getCreditActivity.mockResolvedValue({
    view: 'timeline',
    nextCursor: null,
    entries: [
      { ...base, amountCredits: null, status: 'pending', usageType: 'agent', holdActive: true },
      {
        ...base,
        id: 'r:released',
        referenceId: 'released',
        amountCredits: null,
        status: 'released',
        usageType: 'voice',
        holdActive: false,
        anomaly: 'needs_review',
      },
    ],
  });
});
afterEach(cleanup);
it('shows reservation states without inventing a debit or a missing conversation', async () => {
  render(<CreditActivityPanel accountId="alice" />);
  await screen.findByText(/待结算/);
  expect(screen.getAllByText('未记扣款')).toHaveLength(2);
  expect(screen.getAllByText('会话：未知（原记录未保存关联）')).toHaveLength(2);
  expect(screen.getByText(/已释放/)).toBeTruthy();
  expect(screen.getByText('需要人工核对，不能据此推算费用')).toBeTruthy();
  expect(screen.queryByText('0 Credit')).toBeNull();
});
it('retains visible records when a read-only refresh fails', async () => {
  render(<CreditActivityPanel accountId="alice" />);
  await screen.findByText(/待结算/);
  api.getCreditActivity.mockRejectedValue(new Error('账本暂不可用'));
  fireEvent.click(screen.getByText('刷新账本'));
  await screen.findByRole('alert');
  expect(screen.getByText(/待结算/)).toBeTruthy();
  await waitFor(() => expect(api.getCreditActivity).toHaveBeenCalledTimes(2));
});

it('shows expired Voice as review without presenting its reservation as a debit', async () => {
  api.getCreditActivity.mockResolvedValue({
    view: 'timeline',
    nextCursor: null,
    entries: [
      {
        ...base,
        model: 'voice',
        reservedCredits: 80,
        amountCredits: null,
        status: 'released',
        usageType: 'voice',
        holdActive: false,
        recoveryState: 'needs_review',
        anomaly: 'voice_hold_expired',
      },
    ],
  });
  render(<CreditActivityPanel accountId="alice" />);
  await screen.findByText('语音冻结已过期，已转人工核对；未追加扣费');
  expect(screen.getByText('未记扣款')).toBeTruthy();
  expect(screen.queryByText('-80 Credit')).toBeNull();
});

it('shows group @AI origin without inventing a private conversation', async () => {
  api.getCreditActivity.mockResolvedValue({
    view: 'timeline',
    nextCursor: null,
    entries: [
      {
        ...base,
        amountCredits: -2,
        status: 'settled',
        usageType: 'agent',
        holdActive: false,
        roomId: 'group-1',
        triggerId: 'message-1',
        roleId: 'room',
      },
    ],
  });
  render(<CreditActivityPanel accountId="alice" />);
  await screen.findByText('-2 Credit');
  expect(screen.getByText('群聊：group-1')).toBeTruthy();
  expect(screen.getByText('触发消息：message-1')).toBeTruthy();
  expect(screen.queryByText('会话：未知（原记录未保存关联）')).toBeNull();
});
