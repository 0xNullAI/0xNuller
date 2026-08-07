import { useState } from 'react';
import { Copy, Check, ChevronRight } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { MemberState, CmdAction, DeviceCommand, WaveformTransfer } from '../lib/protocol';
import type { WaveformDefinition } from '../lib/waveforms';
import type { MarketItem } from '../lib/market';
import { BUILTIN_WAVEFORMS } from '../lib/waveforms';
import { MemberCard } from './MemberCard';
import { MemberControl } from './MemberControl';

interface ControlPanelProps {
  members: Map<string, MemberState>;
  peers: string[];
  onSendCommand: (target: string, action: CmdAction, params?: Omit<DeviceCommand, 'action'>) => void;
  onSendWaveform: (targetPeerId: string, transfer: WaveformTransfer) => void;
  roomId: string | null;
  waveforms: WaveformDefinition[];
  onImportWaveform: (file: File) => Promise<string | null>;
  onImportMarketWaveform: (item: MarketItem) => void;
  onRemoveWaveform: (id: string) => void;
  selfState: MemberState;
  selfLimitA: number;
  selfLimitB: number;
  /** 自己的角色头衔。 */
  selfRoleName?: string;
  /** 查某 peer 的角色头衔（场景扮演）。 */
  roleNameFor?: (peerId: string) => string | undefined;
}

function SelfCard({ member, onClick, roleName }: { member: MemberState; onClick: () => void; roleName?: string }) {
  const initial = (member.displayName?.[0] || '?').toUpperCase();
  return (
    <div
      onClick={onClick}
      className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-md)] border border-[var(--accent-soft)] bg-[var(--bg-elevated)] p-3 transition-all hover:bg-[var(--bg-soft)] active:scale-[0.98]"
    >
      <div className="avatar">{initial}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium text-[var(--text)]">{member.displayName}</p>
          <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">我</span>
          {roleName && (
            <span className="shrink-0 truncate rounded-full bg-[var(--bg-soft)] px-1.5 py-0.5 text-[10px] text-[var(--text-soft)]">{roleName}</span>
          )}
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${member.deviceConnected ? 'bg-[var(--success)]' : 'bg-[var(--text-faint)]'}`} />
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--text-soft)]">
          {member.deviceConnected ? (
            <>
              <span>A:{member.strengthA}</span>
              <span>B:{member.strengthB}</span>
              {member.battery != null && <span>{member.battery}%</span>}
            </>
          ) : (
            <span>未连接设备</span>
          )}
        </div>
      </div>
      <ChevronRight size={16} className="shrink-0 text-[var(--text-faint)]" />
    </div>
  );
}

export function ControlPanel({ members, peers, onSendCommand, onSendWaveform, roomId, waveforms, onImportWaveform, onImportMarketWaveform, onRemoveWaveform, selfState, selfLimitA, selfLimitB, selfRoleName, roleNameFor }: ControlPanelProps) {
  const [selectedMember, setSelectedMember] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function copyRoomId() {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // Show member control view
  if (selectedMember) {
    const isSelf = selectedMember === 'self';
    const member = isSelf ? selfState : members.get(selectedMember);

    // When controlling a remote peer, show their waveform catalog; fall back to builtins if not yet received
    const targetWaveforms: WaveformDefinition[] = isSelf
      ? waveforms
      : (member?.waveformCatalog ?? BUILTIN_WAVEFORMS.map(w => ({ id: w.id, name: w.name, custom: false })))
          .map(w => ({ id: w.id, name: w.name, custom: !!w.custom, description: '', frames: [] }));

    return (
      <MemberControl
        peerId={selectedMember}
        member={member}
        onSendCommand={onSendCommand}
        onSendWaveform={onSendWaveform}
        onBack={() => setSelectedMember(null)}
        waveforms={targetWaveforms}
        onImportWaveform={onImportWaveform}
        onImportMarketWaveform={onImportMarketWaveform}
        onRemoveWaveform={onRemoveWaveform}
        isSelf={isSelf}
        limitA={isSelf ? selfLimitA : 200}
        limitB={isSelf ? selfLimitB : 200}
      />
    );
  }

  // Member list view
  const joinUrl = roomId ? `${window.location.origin}${window.location.pathname}?room=${roomId}` : '';

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Room info */}
      {roomId && (
        <div className="border-b border-[var(--surface-border)] px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-medium text-[var(--text-soft)]">房间号</p>
            <button
              onClick={copyRoomId}
              className="flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
            >
              {copied ? (
                <>
                  <Check size={14} className="text-[var(--success)]" />
                  <span className="text-[var(--success)]">已复制</span>
                </>
              ) : (
                <>
                  <Copy size={14} />
                  <span>复制</span>
                </>
              )}
            </button>
          </div>
          <p className="mb-3 text-center text-lg font-bold tracking-widest text-[var(--accent)]">
            {roomId}
          </p>
          {joinUrl && (
            <div className="flex justify-center rounded-[var(--radius-md)] bg-white p-3">
              <QRCodeSVG value={joinUrl} size={120} />
            </div>
          )}
        </div>
      )}

      {/* Member list */}
      <div className="flex-1 px-4 py-3">
        <p className="mb-2 text-xs font-medium text-[var(--text-soft)]">
          成员 ({peers.length + 1})
        </p>
        <div className="space-y-2">
          {/* Self */}
          <SelfCard member={selfState} roleName={selfRoleName} onClick={() => setSelectedMember('self')} />
          {/* Peers */}
          {peers.map(peerId => (
            <MemberCard
              key={peerId}
              peerId={peerId}
              member={members.get(peerId)}
              roleName={roleNameFor?.(peerId)}
              onClick={() => setSelectedMember(peerId)}
            />
          ))}
        </div>
        {peers.length === 0 && (
          <p className="mt-4 text-center text-xs text-[var(--text-faint)]">分享房间号邀请其他人加入</p>
        )}
      </div>
    </div>
  );
}
