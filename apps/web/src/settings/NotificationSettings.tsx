import { useState } from 'react';
import { SettingsGroup, SwitchRow } from './settings-list';
import { setWebNotificationsEnabled, webNotificationsEnabled } from '@0xnullai/settings';

/**
 * There is no system push: most users' phones lack the Google services FCM needs, so new
 * messages surface as in-app unread counts. The web page can additionally raise a browser
 * notification while it is open in the background; the Android WebView has no such API.
 */
export function NotificationSettings({ accountId }: { accountId: string | null }) {
  const androidShell = Boolean((window as Window & { AndroidSystem?: unknown }).AndroidSystem);
  // Unread counts always show in 消息; only the web page can add background notifications.
  if (androidShell || !accountId) return null;
  return <BrowserNotifications accountId={accountId} />;
}

/**
 * Web: the unread count always shows in the navigation and the tab title. System
 * notifications for messages that arrive while the page is in the background are opt-in.
 */
function BrowserNotifications({ accountId }: { accountId: string }) {
  const supported = typeof Notification !== 'undefined';
  const [enabled, setEnabled] = useState(
    () => supported && Notification.permission === 'granted' && webNotificationsEnabled(accountId),
  );
  const [note, setNote] = useState(() =>
    supported && Notification.permission === 'denied'
      ? '浏览器未允许通知，请在网站设置中允许后再开启。'
      : '',
  );
  async function toggle(next: boolean) {
    if (!next) {
      setWebNotificationsEnabled(accountId, false);
      setEnabled(false);
      setNote('');
      return;
    }
    const permission =
      Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission().catch(() => 'denied' as const);
    if (permission !== 'granted') {
      setNote('浏览器未允许通知，请在网站设置中允许后再开启。');
      return;
    }
    setWebNotificationsEnabled(accountId, true);
    setEnabled(true);
    setNote('');
  }
  return (
    <SettingsGroup
      label="通知"
      footer={
        !supported
          ? '当前浏览器不支持通知。'
          : note || '页面在后台时提醒新消息；App 内以未读数提醒。'
      }
    >
      <SwitchRow
        label="新消息通知"
        checked={enabled}
        disabled={!supported}
        onCheckedChange={(next) => void toggle(next)}
      />
    </SettingsGroup>
  );
}
