import { useState } from 'react';
import { setWebNotificationsEnabled, webNotificationsEnabled } from '@0xnullai/settings';

/**
 * There is no system push: most users' phones lack the Google services FCM needs, so new
 * messages surface as in-app unread counts. The web page can additionally raise a browser
 * notification while it is open in the background; the Android WebView has no such API.
 */
export function NotificationSettings({ accountId }: { accountId: string | null }) {
  const androidShell = Boolean((window as Window & { AndroidSystem?: unknown }).AndroidSystem);
  return (
    <section aria-label="通知">
      <h3 className="text-sm font-semibold">通知</h3>
      <p className="mt-3 text-sm text-[var(--text-soft)]">新消息会在「消息」中显示未读。</p>
      {!androidShell && accountId ? <BrowserNotifications accountId={accountId} /> : null}
    </section>
  );
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
      ? '浏览器已阻止本站通知，请在浏览器的网站设置中允许后再开启。'
      : '',
  );
  return (
    <div className="mt-4 border-t border-[var(--surface-border)] pt-4">
      <label className="flex min-h-12 items-center justify-between gap-4 text-sm">
        <strong className="font-medium">浏览器通知</strong>
        <input
          aria-label="浏览器通知"
          type="checkbox"
          checked={enabled}
          disabled={!supported}
          onChange={async (event) => {
            const next = event.target.checked;
            if (!next) {
              setWebNotificationsEnabled(accountId, false);
              setEnabled(false);
              setNote('已关闭浏览器通知。');
              return;
            }
            const permission =
              Notification.permission === 'granted'
                ? 'granted'
                : await Notification.requestPermission().catch(() => 'denied' as const);
            if (permission !== 'granted') {
              setNote('没有获得通知权限。请在浏览器的网站设置中允许通知后再开启。');
              return;
            }
            setWebNotificationsEnabled(accountId, true);
            setEnabled(true);
            setNote('已开启。页面在后台时会提醒新消息。');
          }}
        />
      </label>
      {!supported ? (
        <p className="mt-2 text-xs text-[var(--text-soft)]">当前浏览器不支持系统通知。</p>
      ) : note ? (
        <p role="status" className="mt-2 text-xs text-[var(--text-soft)]">
          {note}
        </p>
      ) : null}
    </div>
  );
}
