// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaReconciliationPanel } from './MediaReconciliationPanel';

const api = vi.hoisted(() => ({
  listMediaBillingReviews: vi.fn(),
  recordMediaBillingReview: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => api);
vi.mock('@0xnullai/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

const review = {
  sequence: 7,
  id: `media:${'a'.repeat(64)}`,
  accountId: 'alice',
  jobId: 'job-12345678',
  kind: 'video',
  reason: 'reservation_expired',
  jobState: 'storing',
  reservedAtReview: 30,
  reservedNow: 0,
  chargedNow: null,
  reservationStatus: 'released',
  reservationUpdatedAt: 110,
  ledgerCount: 0,
  ledgerAmount: null,
  createdAt: 100,
  jobUpdatedAt: 120,
  notes: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  api.listMediaBillingReviews.mockResolvedValue({ items: [review], nextCursor: null });
  api.recordMediaBillingReview.mockResolvedValue({ recorded: true });
});
afterEach(cleanup);

it('shows separate reserved and charged evidence and retries a note with the same event', async () => {
  render(<MediaReconciliationPanel />);
  await screen.findByText(/原冻结 30 Credit/);
  expect(screen.getByText(/已扣 未记录/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '记录备注' }));
  fireEvent.change(screen.getByLabelText('媒体核对备注'), {
    target: { value: '已核对过期预留，等待上游账单。' },
  });
  api.recordMediaBillingReview.mockRejectedValueOnce(new Error('网络超时'));
  fireEvent.click(screen.getByRole('button', { name: '保存备注' }));
  await screen.findByText('网络超时');
  fireEvent.click(screen.getByRole('button', { name: '保存备注' }));
  await screen.findByText('备注已记录；余额、账务状态和媒体交付均未改变。');
  expect(api.recordMediaBillingReview.mock.calls[0]).toEqual(
    api.recordMediaBillingReview.mock.calls[1],
  );
});

it('paginates without duplicating a review', async () => {
  api.listMediaBillingReviews
    .mockResolvedValueOnce({ items: [review], nextCursor: 6 })
    .mockResolvedValueOnce({
      items: [review, { ...review, id: `media:${'b'.repeat(64)}`, sequence: 6 }],
      nextCursor: null,
    });
  render(<MediaReconciliationPanel />);
  fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: '记录备注' })).toHaveLength(2));
  expect(api.listMediaBillingReviews).toHaveBeenLastCalledWith(6);
});
