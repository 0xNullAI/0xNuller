import { Overlay } from '@0xnullai/ui';
import type { AuthUser } from '@0xnullai/auth';
import { AccountContent } from './settings/AccountContent';

export function AccountDialog({
  user,
  onUser,
  onClose,
}: {
  user: AuthUser | null;
  onUser: (user: AuthUser | null) => void;
  onClose: () => void;
}) {
  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="账户"
        className="max-h-[min(680px,calc(100dvh-2rem))] w-[min(420px,calc(100vw-2rem))] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-panel)] sm:p-6"
      >
        <AccountContent user={user} onUser={onUser} onDone={onClose} />
      </div>
    </Overlay>
  );
}
