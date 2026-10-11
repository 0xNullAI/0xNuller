import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NotificationsTab } from './NotificationsTab';

const bridge = {
  isPushConfigured: () => true,
  hasNotificationPermission: () => true,
  openAppSettings: vi.fn(),
};

afterEach(() => {
  cleanup();
  delete (window as Window & { AndroidSystem?: typeof bridge }).AndroidSystem;
  window.localStorage.clear();
  vi.unstubAllEnvs();
});

describe('Android notification preference', () => {
  it('keeps push unavailable in the ordinary web build', () => {
    render(<NotificationsTab accountId="alice" />);
    expect((screen.getByRole('checkbox', { name: '消息通知' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('网页端可查看新消息；系统推送请在 Android 应用中设置。')).toBeTruthy();
  });

  it('distinguishes an Android package without push from a disabled backend', () => {
    const native = window as Window & { AndroidSystem?: typeof bridge };
    native.AndroidSystem = { ...bridge, isPushConfigured: () => false };
    const view = render(<NotificationsTab accountId="alice" />);
    expect(
      screen.getByText('当前 Android 安装包未配置消息推送，应用内消息仍可查看。'),
    ).toBeTruthy();
    native.AndroidSystem = bridge;
    view.rerender(<NotificationsTab key="configured" accountId="alice" />);
    expect(
      screen.getByText('当前服务尚未启用 Android 消息推送，应用内消息仍可查看。'),
    ).toBeTruthy();
  });

  it('opts in per account and can opt out without affecting another account', () => {
    vi.stubEnv('VITE_ANDROID_PUSH_BACKEND_ENABLED', 'true');
    (window as Window & { AndroidSystem?: typeof bridge }).AndroidSystem = bridge;
    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener('0xnullai:push-preference', listener);
    try {
      const view = render(<NotificationsTab accountId="alice" />);
      const toggle = screen.getByRole('checkbox', { name: '消息通知' });
      fireEvent.click(toggle);
      expect((toggle as HTMLInputElement).checked).toBe(true);
      expect(window.localStorage.getItem('android-push-enabled:alice')).toBe('true');
      view.rerender(<NotificationsTab key="bob" accountId="bob" />);
      expect((screen.getByRole('checkbox', { name: '消息通知' }) as HTMLInputElement).checked).toBe(
        false,
      );
      view.rerender(<NotificationsTab key="alice" accountId="alice" />);
      fireEvent.click(screen.getByRole('checkbox', { name: '消息通知' }));
      expect(window.localStorage.getItem('android-push-enabled:alice')).toBe('false');
      expect(events).toEqual([
        { accountId: 'alice', enabled: true },
        { accountId: 'alice', enabled: false },
      ]);
    } finally {
      window.removeEventListener('0xnullai:push-preference', listener);
    }
  });
});

describe('browser notification preference', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the browser for permission and stays off when it is refused', async () => {
    const requestPermission = vi.fn(async () => 'denied' as NotificationPermission);
    vi.stubGlobal(
      'Notification',
      Object.assign(vi.fn(), { permission: 'default', requestPermission }),
    );
    render(<NotificationsTab accountId="alice" />);
    const toggle = screen.getByRole('checkbox', { name: '浏览器通知' }) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(
      await screen.findByText('没有获得通知权限。请在浏览器的网站设置中允许通知后再开启。'),
    ).toBeTruthy();
    expect(toggle.checked).toBe(false);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('turns on after permission is granted and remembers it per account', async () => {
    const api = Object.assign(vi.fn(), {
      permission: 'default' as NotificationPermission,
      requestPermission: vi.fn(async () => {
        api.permission = 'granted';
        return 'granted' as NotificationPermission;
      }),
    });
    vi.stubGlobal('Notification', api);
    const view = render(<NotificationsTab accountId="alice" />);
    fireEvent.click(screen.getByRole('checkbox', { name: '浏览器通知' }));
    expect(await screen.findByText('已开启。页面在后台时会提醒新消息。')).toBeTruthy();
    view.unmount();
    render(<NotificationsTab accountId="alice" />);
    expect((screen.getByRole('checkbox', { name: '浏览器通知' }) as HTMLInputElement).checked).toBe(
      true,
    );
    cleanup();
    render(<NotificationsTab accountId="bob" />);
    expect((screen.getByRole('checkbox', { name: '浏览器通知' }) as HTMLInputElement).checked).toBe(
      false,
    );
  });
});
