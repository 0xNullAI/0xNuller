import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetCreditBalanceForTests, useCreditBalance } from './credit-balance';

const auth = vi.hoisted(() => ({
  account: 'alice' as string | null,
  balance: 10,
  calls: 0,
  listeners: new Set<() => void>(),
}));

vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => auth.account,
  getCreditBalance: async () => {
    auth.calls++;
    return { total: auth.balance, reserved: 0, available: auth.balance };
  },
  subscribeAuthChanges: (listener: () => void) => {
    auth.listeners.add(listener);
    return () => auth.listeners.delete(listener);
  },
}));

function Reader({ label, owner }: { label: string; owner: string | null }) {
  const balance = useCreditBalance(owner);
  return <output aria-label={label}>{balance ? balance.available : '—'}</output>;
}

beforeEach(() => {
  auth.account = 'alice';
  auth.balance = 10;
  auth.calls = 0;
  auth.listeners.clear();
});

afterEach(() => {
  cleanup();
  resetCreditBalanceForTests();
  vi.useRealTimers();
});

it('polls once for every reader, and not at all while the page is hidden', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  try {
    render(
      <>
        <Reader label="导航" owner="alice" />
        <Reader label="账户" owner="alice" />
      </>,
    );
    await act(async () => {});
    expect(screen.getByRole('status', { name: '导航' }).textContent).toBe('10');
    expect(screen.getByRole('status', { name: '账户' }).textContent).toBe('10');
    const opened = auth.calls;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(auth.calls).toBe(opened + 1);

    visibility.mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(auth.calls).toBe(opened + 1);

    auth.balance = 25;
    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(auth.calls).toBe(opened + 2);
    expect(screen.getByRole('status', { name: '导航' }).textContent).toBe('25');
  } finally {
    visibility.mockRestore();
  }
});

it('never shows the previous account its balance after a sign-out or switch', async () => {
  const view = render(<Reader label="导航" owner="alice" />);
  await act(async () => {});
  expect(screen.getByRole('status', { name: '导航' }).textContent).toBe('10');

  auth.account = null;
  act(() => {
    for (const listener of auth.listeners) listener();
  });
  view.rerender(<Reader label="导航" owner={null} />);
  expect(screen.getByRole('status', { name: '导航' }).textContent).toBe('—');

  auth.account = 'bob';
  auth.balance = 3;
  view.rerender(<Reader label="导航" owner="bob" />);
  expect(screen.getByRole('status', { name: '导航' }).textContent).toBe('—');
  await act(async () => {
    for (const listener of auth.listeners) listener();
  });
  expect(screen.getByRole('status', { name: '导航' }).textContent).toBe('3');
});
