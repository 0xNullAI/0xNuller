// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { BillingOrdersPanel } from './BillingOrdersPanel';
const api = vi.hoisted(() => ({
  getBillingCatalog: vi.fn(),
  listBillingOrders: vi.fn(),
  createBillingOrder: vi.fn(),
  cancelBillingOrder: vi.fn(),
  requestBillingRefund: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => api);
vi.mock('@0xnullai/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
const order = {
  id: 'order_001',
  packageId: 'credit-1000',
  credits: 1000,
  amountMinor: 700,
  currency: 'CNY',
  priceVersion: 'v1',
  status: 'awaiting_payment',
  version: 1,
};
beforeEach(() => {
  vi.resetAllMocks();
  api.getBillingCatalog.mockResolvedValue({
    priceVersion: 'v1',
    onlinePaymentEnabled: false,
    message: '在线支付尚未接通',
    packages: [{ id: 'credit-1000', credits: 1000, amountMinor: 700 }],
  });
  api.listBillingOrders.mockResolvedValue({ items: [], nextCursor: null });
  api.createBillingOrder.mockResolvedValue({ item: order });
});
afterEach(cleanup);
describe('billing orders wallet', () => {
  it('shows nothing for an account without orders, and offers no way to open a new one', async () => {
    const { container } = render(<BillingOrdersPanel accountId="alice" />);
    await waitFor(() => expect(api.listBillingOrders).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(api.getBillingCatalog).not.toHaveBeenCalled();
  });
  it('lists an old order and still lets it be cancelled', async () => {
    api.listBillingOrders.mockResolvedValue({ items: [order], nextCursor: null });
    api.cancelBillingOrder.mockResolvedValue({ item: { ...order, status: 'cancelled' } });
    render(<BillingOrdersPanel accountId="alice" />);
    fireEvent.click(await screen.findByText('取消订单'));
    await waitFor(() => expect(api.cancelBillingOrder).toHaveBeenCalledWith(order));
    expect(screen.queryByText('创建待确认订单')).toBeNull();
  });
  it('sends an owned paid order refund request with its current version and no automatic cash refund', async () => {
    api.listBillingOrders.mockResolvedValue({
      items: [{ ...order, status: 'paid', version: 2 }],
      nextCursor: null,
    });
    api.requestBillingRefund.mockResolvedValue({ item: { ...order, status: 'refund_requested' } });
    render(<BillingOrdersPanel accountId="alice" />);
    await screen.findByText('申请退款');
    fireEvent.click(screen.getByText('申请退款'));
    fireEvent.change(screen.getByLabelText('退款原因'), { target: { value: '不再需要' } });
    fireEvent.submit(screen.getByText('提交退款申请').closest('form')!);
    await waitFor(() =>
      expect(api.requestBillingRefund).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'order_001', version: 2 }),
        '不再需要',
      ),
    );
    await screen.findByText(/应用未执行退款/);
  });
});
