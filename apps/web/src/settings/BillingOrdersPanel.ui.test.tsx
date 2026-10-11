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
  it('creates a server-quoted pending order without claiming a successful payment', async () => {
    render(<BillingOrdersPanel accountId="alice" />);
    await screen.findByText('在线支付尚未接通');
    await waitFor(() =>
      expect((screen.getByText('创建待确认订单') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByText('创建待确认订单'));
    await waitFor(() =>
      expect(api.createBillingOrder).toHaveBeenCalledWith(expect.any(String), 'credit-1000', 'v1'),
    );
    await screen.findByText(/订单已创建，尚未扣款或增加Credit/);
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
