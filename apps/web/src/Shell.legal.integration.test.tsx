import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type * as AuthModule from '@0xnullai/auth';
import { Shell } from './Shell';

const auth = vi.hoisted(() => ({
  me: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@0xnullai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  ...auth,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  auth.me.mockImplementation(() => Promise.resolve(null));
});

describe('公开的用户协议地址', () => {
  it('未登录时 /legal/terms 直接显示协议而不是登录入口', async () => {
    window.history.pushState(null, '', '/legal/terms');
    await act(async () => {
      render(<Shell />);
    });
    const page = await screen.findByRole('main', { name: '用户协议' });
    expect(page.textContent).toContain('版本：');
    expect(screen.getByRole('article', { name: '用户协议' })).toBeTruthy();
    expect(screen.queryByRole('main', { name: '账户登录' })).toBeNull();
  });

  it('账户服务尚未应答时也能阅读', async () => {
    auth.me.mockImplementation(() => new Promise(() => {}));
    window.history.pushState(null, '', '/legal/terms');
    await act(async () => {
      render(<Shell />);
    });
    expect(await screen.findByRole('main', { name: '用户协议' })).toBeTruthy();
  });

  it('不再提供隐私政策页面', async () => {
    window.history.pushState(null, '', '/legal/privacy');
    await act(async () => {
      render(<Shell />);
    });
    expect(screen.queryByRole('main', { name: '隐私政策' })).toBeNull();
  });
});
