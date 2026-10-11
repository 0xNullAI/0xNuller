import { useState } from 'react';
import {
  androidPushEnabled,
  setAndroidPushEnabled,
  setWebNotificationsEnabled,
  webNotificationsEnabled,
} from '@0xnullai/settings';

type PushStatusBridge = {
  isPushConfigured(): boolean;
  hasNotificationPermission(): boolean;
  openAppSettings(): void;
};

function nativePush(): PushStatusBridge | undefined {
  return (window as Window & { AndroidSystem?: PushStatusBridge }).AndroidSystem;
}

export function NotificationsTab({ accountId }: { accountId: string | null }) {
  const [enabled, setEnabled] = useState(() => androidPushEnabled(accountId));
  const [message, setMessage] = useState('');
  const bridge = nativePush();
  const available = Boolean(
    accountId &&
    bridge?.isPushConfigured() &&
    import.meta.env.VITE_ANDROID_PUSH_BACKEND_ENABLED === 'true',
  );
  const unavailableMessage = !accountId
    ? '登录后可设置 Android 消息通知。'
    : !bridge
      ? '网页端可查看新消息；系统推送请在 Android 应用中设置。'
      : !bridge.isPushConfigured()
        ? '当前 Android 安装包未配置消息推送，应用内消息仍可查看。'
        : '当前服务尚未启用 Android 消息推送，应用内消息仍可查看。';
  return (
    <section className="max-w-lg rounded-2xl bg-[var(--bg-elevated)] p-4">
      <label className="flex min-h-12 items-center justify-between gap-4 text-sm">
        <strong className="font-medium">消息通知</strong>
        <input
          aria-label="消息通知"
          type="checkbox"
          checked={available && enabled}
          disabled={!available}
          onChange={(event) => {
            if (!accountId) return;
            const next = event.target.checked;
            const saved = setAndroidPushEnabled(accountId, next);
            if (!saved && next) {
              setMessage('无法保存通知设置，请检查应用存储权限。');
              return;
            }
            setEnabled(next);
            setMessage(
              next
                ? '正在开启通知，请按系统提示授权。'
                : saved
                  ? '已关闭通知。'
                  : '已在本机关闭通知，设置可能无法持久保存。',
            );
            window.dispatchEvent(
              new CustomEvent('0xnullai:push-preference', { detail: { accountId, enabled: next } }),
            );
          }}
        />
      </label>
      {!available ? (
        <p className="mt-2 text-xs text-[var(--text-soft)]">{unavailableMessage}</p>
      ) : enabled && !bridge?.hasNotificationPermission() ? (
        <p className="mt-2 text-xs text-[var(--text-soft)]">
          如未弹出系统授权，请在 Android 应用设置中允许通知。{' '}
          <button
            type="button"
            className="text-[var(--accent)] underline"
            onClick={() => bridge?.openAppSettings()}
          >
            打开应用设置
          </button>
        </p>
      ) : null}
      {message ? (
        <p role="status" className="mt-2 text-xs text-[var(--text-soft)]">
          {message}
        </p>
      ) : null}
      {!bridge && accountId ? <BrowserNotifications accountId={accountId} /> : null}
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
