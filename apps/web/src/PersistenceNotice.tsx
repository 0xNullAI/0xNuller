import { useSyncExternalStore } from 'react';
import { persistenceWarning, subscribePersistenceWarning } from '@0xnullai/settings';
export function PersistenceNotice() {
  const message = useSyncExternalStore(subscribePersistenceWarning, persistenceWarning, () => '');
  return message ? (
    <div
      role="status"
      className="border-b border-[var(--warning-border)] bg-[var(--warning-surface)] px-3 py-2 text-sm text-[var(--warning)]"
    >
      {message}
    </div>
  ) : null;
}
