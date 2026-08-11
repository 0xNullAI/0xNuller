import { ChevronRight } from 'lucide-react';
import type { MemberState } from '../lib/protocol';
import { ProfileAvatar } from './ProfileAvatar';
import { requestProfileView } from '@0xnullai/auth';

interface MemberCardProps {
  peerId: string;
  member: MemberState | undefined;
  onClick: () => void;
}

export function MemberCard({ peerId, member, onClick }: MemberCardProps) {
  const name = member?.displayName || peerId.slice(0, 8);
  const connected = member?.deviceConnected ?? false;

  return (
    <div
      onClick={onClick}
      className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-3 transition-all hover:bg-[var(--bg-soft)] active:scale-[0.98]"
    >
      {/* Avatar. Inert unless this peer has an account behind them — most
          room members do not, and an avatar that opens an empty page is worse
          than one that does nothing. Avatar enforces that itself. */}
      <ProfileAvatar name={name} username={member?.username} size={40} />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {member?.username ? (
            <button
              type="button"
              className="truncate text-sm font-medium text-[var(--text)] hover:text-[var(--accent)] hover:underline"
              onClick={(event) => {
                event.stopPropagation();
                requestProfileView(member.username!);
              }}
            >
              {name}
            </button>
          ) : (
            <p className="truncate text-sm font-medium text-[var(--text)]">{name}</p>
          )}
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              connected ? 'bg-[var(--success)]' : 'bg-[var(--text-faint)]'
            }`}
          />
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--text-soft)]">
          {connected ? (
            <>
              <span>A:{member!.strengthA}</span>
              <span>B:{member!.strengthB}</span>
              {member!.battery != null && <span>{member!.battery}%</span>}
            </>
          ) : (
            <span>未连接设备</span>
          )}
        </div>
      </div>

      {/* Arrow */}
      <ChevronRight size={16} className="shrink-0 text-[var(--text-faint)]" />
    </div>
  );
}
