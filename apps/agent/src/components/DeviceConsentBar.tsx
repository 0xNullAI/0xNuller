import { useState, useSyncExternalStore } from 'react';
import {
  deviceConversationAccess,
  setDeviceConversationAccess,
  subscribeDeviceConversationAccess,
} from '@0xnullai/settings';

/**
 * Inline shortcut for the per-chat device consent. It writes the same record as the
 * chat settings checkbox; lease, limits, and confirmation still apply at execution.
 */
export function DeviceConsentBar({
  accountId,
  conversationId,
  deviceConnected,
}: {
  accountId: string | null;
  conversationId: string | null;
  deviceConnected: boolean;
}) {
  const allowed = useSyncExternalStore(
    subscribeDeviceConversationAccess,
    () => deviceConversationAccess(accountId, 'ai', conversationId ?? ''),
    () => false,
  );
  const [error, setError] = useState('');
  if (!deviceConnected || !accountId || !conversationId || allowed) return null;
  return (
    <div
      role="region"
      aria-label="本聊天的设备权限"
      className="flex min-w-0 items-center gap-2 px-2 text-xs"
    >
      <span className="min-w-0 flex-1 truncate text-[var(--text-faint)]">
        {error ? (
          <span role="alert" className="text-[var(--danger)]">
            {error}
          </span>
        ) : (
          '允许本聊天控制设备？'
        )}
      </span>
      <button
        type="button"
        className="ui-press shrink-0 rounded-full px-2 py-1 font-medium text-[var(--accent-text)] hover:bg-[var(--accent-soft)]"
        onClick={() => {
          const saved = setDeviceConversationAccess(accountId, 'ai', conversationId, true);
          setError(saved ? '' : '无法保存授权，请检查浏览器存储');
        }}
      >
        允许
      </button>
    </div>
  );
}
