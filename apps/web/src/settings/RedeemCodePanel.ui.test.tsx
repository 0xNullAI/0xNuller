// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedeemCodePanel } from './RedeemCodePanel';

const api = vi.hoisted(() => ({ redeemCreditCode: vi.fn() }));
const balance = vi.hoisted(() => ({ refreshCreditBalance: vi.fn() }));
vi.mock('@0xnullai/auth', () => api);
vi.mock('../credit-balance', () => balance);
vi.mock('@0xnullai/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

const CODE = 'A2'.repeat(32);

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('卡密兑换', () => {
  it('只有 64 位卡密才能提交，成功后清空输入并刷新余额', async () => {
    api.redeemCreditCode.mockResolvedValue({ ok: true, amountCredits: 1000 });
    render(<RedeemCodePanel />);
    const input = screen.getByRole('textbox', { name: '卡密兑换' });
    const button = screen.getByRole('button', { name: '兑换' }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: 'ABC' } });
    expect(button.disabled).toBe(true);
    expect(screen.getByText('卡密应为 64 位')).toBeTruthy();

    // Spaces, dashes and lower case are accepted as typed.
    const typed = CODE.toLowerCase().replace(/(.{8})/g, '$1 ');
    fireEvent.change(input, { target: { value: typed } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await screen.findByText('兑换成功，已到账 1000 Credit');
    expect(api.redeemCreditCode).toHaveBeenCalledWith(typed);
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(balance.refreshCreditBalance).toHaveBeenCalled();
  });

  it('显示服务端的拒绝原因，并保留输入', async () => {
    api.redeemCreditCode.mockRejectedValue(new Error('这个卡密已经被使用'));
    render(<RedeemCodePanel />);
    const input = screen.getByRole('textbox', { name: '卡密兑换' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: CODE } });
    fireEvent.click(screen.getByRole('button', { name: '兑换' }));

    expect((await screen.findByRole('alert')).textContent).toBe('这个卡密已经被使用');
    await waitFor(() => expect(input.value).toBe(CODE));
  });
});
