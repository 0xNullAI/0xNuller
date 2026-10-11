// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { BillingReconciliationPanel } from './BillingReconciliationPanel';
const api = vi.hoisted(() => ({
  currentAuthUserId: () => 'admin',
  subscribeAuthChanges: () => () => {},
  listBillingOrders: vi.fn(),
  listTextBillingReviews: vi.fn(),
  listVoiceBillingReviews: vi.fn(),
  recordVoiceBillingReview: vi.fn(),
  listMediaBillingReviews: vi.fn(),
  listAsrBillingReviews: vi.fn(),
  recordMediaBillingReview: vi.fn(),
  recordTextBillingReview: vi.fn(),
  listBillingReconciliation: vi.fn(),
  confirmBillingPayment: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => api);
vi.mock('./BillingOrdersPanel', () => ({
  BILLING_STATUSES: { awaiting_payment: '待人工核实付款' },
}));
vi.mock('@0xnullai/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
const order = {
  id: 'order_001',
  credits: 1000,
  amountMinor: 700,
  currency: 'CNY',
  status: 'awaiting_payment',
  accountId: 'alice',
};
beforeEach(() => {
  vi.resetAllMocks();
  api.listVoiceBillingReviews.mockResolvedValue({ items: [], nextCursor: null });
  api.listMediaBillingReviews.mockResolvedValue({ items: [], nextCursor: null });
  api.listAsrBillingReviews.mockResolvedValue({ items: [], nextCursor: null });
  api.listTextBillingReviews.mockResolvedValue({
    items: [
      {
        id: 'text:review:001',
        accountId: 'alice',
        model: 'balanced',
        state: 'needs_review',
        status: 'released',
        confirmedCharge: null,
        charged: null,
        reserved: 20,
        reason: 'interrupted_without_usage',
        updatedAt: 1,
        attempts: 0,
        promptTokens: null,
        completionTokens: null,
        notes: [],
      },
    ],
    nextCursor: null,
  });
  api.recordTextBillingReview.mockResolvedValue({ recorded: true });
  api.listBillingOrders.mockResolvedValue({ items: [order], nextCursor: null });
  api.listBillingReconciliation.mockResolvedValue({ events: [] });
  api.confirmBillingPayment.mockResolvedValue({ state: 'needs_review', reason: '流水已使用' });
});
afterEach(cleanup);
describe('administrator payment reconciliation', () => {
  it('requires explicit external payment verification and displays unresolved results without claiming funding', async () => {
    render(<BillingReconciliationPanel />);
    await screen.findByText('核实已实际收款');
    fireEvent.click(screen.getByText('核实已实际收款'));
    expect((screen.getByText('记录事实并同步账本') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('订单付款流水'), { target: { value: 'receipt_001' } });
    fireEvent.click(screen.getByLabelText(/我已核对原始支付渠道/));
    fireEvent.submit(screen.getByText('记录事实并同步账本').closest('form')!);
    await waitFor(() =>
      expect(api.confirmBillingPayment).toHaveBeenCalledWith(
        order,
        'receipt_001',
        expect.any(String),
        false,
      ),
    );
    await screen.findByText('流水已使用');
    expect(screen.queryByText('外部付款事实已记录，账本同步完成。')).toBeNull();
  });
});

it('records review evidence without suggesting that unknown usage was charged or repaired', async () => {
  render(<BillingReconciliationPanel />);
  fireEvent.click(await screen.findByText('记录核对备注：text:review:001'));
  expect((screen.getByText('保存核对备注（不改账）') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('文字账务核对备注'), {
    target: { value: '无法确认上游用量，保留异常记录。' },
  });
  fireEvent.submit(screen.getByText('保存核对备注（不改账）').closest('form')!);
  await waitFor(() =>
    expect(api.recordTextBillingReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'text:review:001', confirmedCharge: null }),
      expect.any(String),
      '无法确认上游用量，保留异常记录。',
    ),
  );
  await screen.findByText('核对备注已记录，未改变余额或账务状态。');
  expect(api.confirmBillingPayment).not.toHaveBeenCalled();
});
it('preserves evidence on a stale-state conflict instead of claiming reconciliation succeeded', async () => {
  api.recordTextBillingReview.mockRejectedValue(new Error('账务状态已变化，请刷新后核对'));
  render(<BillingReconciliationPanel />);
  fireEvent.click(await screen.findByText('记录核对备注：text:review:001'));
  fireEvent.change(screen.getByLabelText('文字账务核对备注'), {
    target: { value: '已核对但状态需要刷新' },
  });
  fireEvent.submit(screen.getByText('保存核对备注（不改账）').closest('form')!);
  await screen.findByText('账务状态已变化，请刷新后核对');
  expect((screen.getByLabelText('文字账务核对备注') as HTMLTextAreaElement).value).toBe(
    '已核对但状态需要刷新',
  );
  expect(screen.queryByText('核对备注已记录，未改变余额或账务状态。')).toBeNull();
});
