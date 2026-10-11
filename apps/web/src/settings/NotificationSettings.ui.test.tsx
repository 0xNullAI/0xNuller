import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotificationSettings } from './NotificationSettings';

afterEach(() => {
  cleanup();
  delete (window as Window & { AndroidSystem?: unknown }).AndroidSystem;
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const toggle = () => screen.getByRole('switch', { name: '新消息通知' });

describe('通知 switch', () => {
  it('is a single switch on the web and absent inside the Android app or signed out', () => {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default' }));
    const view = render(<NotificationSettings accountId="alice" />);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    view.unmount();
    render(<NotificationSettings accountId={null} />);
    expect(screen.queryByRole('switch')).toBeNull();
    cleanup();
    (window as Window & { AndroidSystem?: unknown }).AndroidSystem = {};
    render(<NotificationSettings accountId="alice" />);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('asks the browser for permission and stays off when it is refused', async () => {
    const requestPermission = vi.fn(async () => 'denied' as NotificationPermission);
    vi.stubGlobal(
      'Notification',
      Object.assign(vi.fn(), { permission: 'default', requestPermission }),
    );
    render(<NotificationSettings accountId="alice" />);
    fireEvent.click(toggle());
    expect(await screen.findByText('浏览器未允许通知，请在网站设置中允许后再开启。')).toBeTruthy();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('turns on after permission is granted, remembers it per account and turns off', async () => {
    const api = Object.assign(vi.fn(), {
      permission: 'default' as NotificationPermission,
      requestPermission: vi.fn(async () => {
        api.permission = 'granted';
        return 'granted' as NotificationPermission;
      }),
    });
    vi.stubGlobal('Notification', api);
    const view = render(<NotificationSettings accountId="alice" />);
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    view.unmount();
    const again = render(<NotificationSettings accountId="alice" />);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    again.unmount();
    render(<NotificationSettings accountId="bob" />);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });
});
