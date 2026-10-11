import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type * as AuthModule from '@0xnullai/auth';
import type { AuthUser } from '@0xnullai/auth';
import { AccountContent } from './AccountContent';

const auth = vi.hoisted(() => ({
  confirmEmailVerification: vi.fn(() => Promise.resolve()),
  me: vi.fn(() => Promise.resolve(null as AuthUser | null)),
}));

vi.mock('@0xnullai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  ...auth,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.clearAllMocks();
});

it('submits a verification link once even when the parent re-renders with a new callback', async () => {
  window.history.replaceState(null, '', '/settings?verify=link-token');
  const view = render(<AccountContent user={null} onUser={() => {}} onDone={() => {}} />);
  expect(window.location.search).toBe('');
  view.rerender(<AccountContent user={null} onUser={() => {}} onDone={() => {}} />);

  await waitFor(() => expect(screen.getByText('邮箱验证成功')).toBeTruthy());
  expect(auth.confirmEmailVerification).toHaveBeenCalledOnce();
  expect(auth.confirmEmailVerification).toHaveBeenCalledWith('link-token');
  expect(screen.queryByText('验证链接无效或已过期')).toBeNull();
});
