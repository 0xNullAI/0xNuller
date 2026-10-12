import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('公开的法律文档地址', () => {
  it.each([
    ['/legal/privacy', '隐私政策'],
    ['/legal/terms', '用户协议'],
  ])('未登录时 %s 直接显示文档而不是登录入口', async (path, title) => {
    window.history.pushState(null, '', path);
    await act(async () => {
      render(<Shell />);
    });
    const page = await screen.findByRole('main', { name: title });
    expect(page.textContent).toContain('草稿 · 待法务审阅');
    expect(screen.getByRole('article', { name: title })).toBeTruthy();
    expect(screen.queryByRole('main', { name: '账户登录' })).toBeNull();
  });

  it('账户服务尚未应答时也能阅读，并可在两份文档之间切换', async () => {
    auth.me.mockImplementation(() => new Promise(() => {}));
    window.history.pushState(null, '', '/legal/privacy');
    await act(async () => {
      render(<Shell />);
    });
    await screen.findByRole('main', { name: '隐私政策' });
    fireEvent.click(screen.getByRole('button', { name: '用户协议' }));
    expect(window.location.pathname).toBe('/legal/terms');
    expect(await screen.findByRole('main', { name: '用户协议' })).toBeTruthy();
  });
});
