// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VoiceReconciliationPanel } from './VoiceReconciliationPanel';
const api = vi.hoisted(() => ({
  listVoiceBillingReviews: vi.fn(),
  recordVoiceBillingReview: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => api);
vi.mock('@0xnullai/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
const item = {
  id: 'voice:review:001',
  accountId: 'alice',
  status: 'released',
  charged: null,
  updatedAt: 200,
  reason: 'reservation_expired',
  requestedAction: 'settle',
  durationMs: 40000,
  requestedCredits: 80,
  reserved: 80,
  priceVersion: 'v1',
  holdUpdatedAt: 1,
  createdAt: 100,
  notes: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  api.listVoiceBillingReviews.mockResolvedValue({ items: [item], nextCursor: null });
  api.recordVoiceBillingReview.mockResolvedValue({ recorded: true });
});
afterEach(cleanup);
it('shows quoted evidence separately from debit and preserves the same note event on retry', async () => {
  render(<VoiceReconciliationPanel />);
  await screen.findByText(/实扣 未扣费/);
  expect(screen.getByText(/非扣款/)).toBeTruthy();
  fireEvent.click(screen.getByText(`记录核对备注：${item.id}`));
  fireEvent.change(screen.getByLabelText('语音账务核对备注'), {
    target: { value: '已核对过期，请保留证据。' },
  });
  api.recordVoiceBillingReview.mockRejectedValueOnce(new Error('网络超时'));
  const submit = () => fireEvent.submit(screen.getByLabelText('语音账务核对备注').closest('form')!);
  submit();
  await screen.findByText('网络超时');
  submit();
  await screen.findByText('核对备注已记录，未改变余额或账务状态。');
  expect(api.recordVoiceBillingReview.mock.calls[0]).toEqual(
    api.recordVoiceBillingReview.mock.calls[1],
  );
});
it('applies account and time filters to every page and drops obsolete list results', async () => {
  let resolveOld!: (value: unknown) => void;
  api.listVoiceBillingReviews.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  render(<VoiceReconciliationPanel />);
  fireEvent.change(screen.getByLabelText('语音审核账户'), { target: { value: 'bob' } });
  fireEvent.change(screen.getByLabelText('语音审核开始时间'), {
    target: { value: '2026-09-01T10:00' },
  });
  api.listVoiceBillingReviews.mockResolvedValueOnce({ items: [], nextCursor: 10 });
  fireEvent.submit(screen.getByRole('form', { name: '筛选语音审核' }));
  await screen.findByText('更早语音记录');
  const filter = { accountId: 'bob', from: new Date('2026-09-01T10:00').getTime(), to: undefined };
  expect(api.listVoiceBillingReviews).toHaveBeenLastCalledWith(filter);
  resolveOld({ items: [item], nextCursor: null });
  api.listVoiceBillingReviews.mockResolvedValueOnce({ items: [], nextCursor: null });
  fireEvent.click(screen.getByText('更早语音记录'));
  await waitFor(() => expect(api.listVoiceBillingReviews).toHaveBeenLastCalledWith(filter, 10));
  expect(screen.queryByText(`记录核对备注：${item.id}`)).toBeNull();
});
