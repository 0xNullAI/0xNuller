import { useState } from 'react';
import { Switch } from '@0xnullai/ui';
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
    <section aria-label="通知">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold">通知</h3>
        <Switch
          label="通知"
          checked={enabled}
          disabled={!supported}
          onCheckedChange={(next) => void toggle(next)}
        />
      </div>
      {!supported ? (
        <p className="mt-2 text-xs text-[var(--text-faint)]">当前浏览器不支持通知。</p>
      ) : note ? (
        <p role="status" className="mt-2 text-xs text-[var(--text-faint)]">
          {note}
        </p>
      ) : null}
    </section>
  );
}
