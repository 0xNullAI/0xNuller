import { useState } from 'react';
import type { RoomStatus, JoinOptions } from '../hooks/use-peer-room';
import { Loader2, Globe, Lock, LayoutGrid } from 'lucide-react';

interface RoomEntryProps {
  displayName: string;
  onNameChange: (name: string) => void;
  onJoin: (roomCode: string, options?: JoinOptions) => void;
  status: RoomStatus;
  error: string | null;
}

export function RoomEntry({ displayName, onNameChange, onJoin, status, error }: RoomEntryProps) {
  const [roomCode, setRoomCode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('room') ?? '';
  });
  const [isPublic, setIsPublic] = useState(false);
  const [roomName, setRoomName] = useState('');

  const connecting = status === 'connecting';

  function createRoom() {
    if (!displayName.trim()) return;
    const code = Math.random().toString(36).substring(2, 8);
    onJoin(code, { public: isPublic, roomName: isPublic ? roomName.trim() || displayName.trim() : undefined });
  }

  function joinRoom() {
    if (!displayName.trim()) return;
    const code = roomCode.trim() || '0xNullAI';
    // 加入已有房间不改变其公开状态。
    onJoin(code);
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-sm animate-fade-up rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow)]">
        <h1 className="mb-6 text-center text-2xl font-bold text-[var(--text)]">DG-Chat</h1>
        <p className="mb-4 text-center text-sm text-[var(--text-soft)]">多人聊天 &amp; 远程控制</p>

        {error && (
          <div className="mb-4 rounded-[var(--radius-sm)] border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}

        <div className="mb-4">
          <label className="mb-1 block text-xs text-[var(--text-soft)]">你的昵称</label>
          <input
            type="text"
            value={displayName}
            onChange={e => onNameChange(e.target.value)}
            placeholder="输入昵称..."
            disabled={connecting}
            className="w-full rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] outline-none focus:border-[var(--accent)] transition-colors disabled:opacity-50"
            style={{ fontSize: '16px' }}
          />
        </div>

        {/* 公开开关：标签恒为「公开到大厅」，开=公开房、关=私密房 */}
        <button
          type="button"
          onClick={() => setIsPublic(p => !p)}
          disabled={connecting}
          className="mb-2 flex w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-3 py-2.5 text-sm transition-colors hover:border-[var(--accent)] disabled:opacity-50"
        >
          <span className="flex min-w-0 flex-col items-start">
            <span className="flex items-center gap-2 text-[var(--text)]">
              {isPublic ? <Globe className="h-4 w-4 text-[var(--accent)]" /> : <Lock className="h-4 w-4 text-[var(--text-soft)]" />}
              公开到大厅
            </span>
            <span className="mt-0.5 text-left text-[11px] text-[var(--text-faint)]">
              {isPublic ? '房间将出现在大厅，任何人可加入' : '关闭 = 私密房间，仅凭房间号加入'}
            </span>
          </span>
          <span
            className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors ${isPublic ? 'bg-[var(--accent)]' : 'bg-[var(--surface-border)]'}`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${isPublic ? 'translate-x-4' : 'translate-x-0'}`}
            />
          </span>
        </button>

        {isPublic && (
          <input
            type="text"
            value={roomName}
            onChange={e => setRoomName(e.target.value)}
            placeholder="房间名（大厅里显示，留空用昵称）"
            disabled={connecting}
            className="mb-3 w-full rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] outline-none focus:border-[var(--accent)] transition-colors disabled:opacity-50"
            style={{ fontSize: '16px' }}
          />
        )}

        <button
          onClick={createRoom}
          disabled={!displayName.trim() || connecting}
          className="mt-1 flex w-full items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--button-text)] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {connecting ? '正在连接...' : '创建房间'}
        </button>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-[var(--surface-border)]" />
          <span className="text-xs text-[var(--text-faint)]">或加入已有房间</span>
          <div className="h-px flex-1 bg-[var(--surface-border)]" />
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={roomCode}
            onChange={e => setRoomCode(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && joinRoom()}
            placeholder="0xNullAI"
            disabled={connecting}
            className="flex-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] outline-none focus:border-[var(--accent)] transition-colors disabled:opacity-50"
            style={{ fontSize: '16px' }}
          />
          <button
            onClick={joinRoom}
            disabled={!displayName.trim() || connecting}
            className="flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[var(--button-text)] transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            加入
          </button>
        </div>

        {/* 浏览大厅 */}
        <a
          href="/lobby"
          className="mt-4 flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-4 py-2.5 text-sm text-[var(--text-soft)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <LayoutGrid className="h-4 w-4" />
          浏览公开房间大厅
        </a>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-[var(--text-faint)]">
          公开房间会出现在大厅，任何人可加入；私密房间需房间号。
        </p>
        <p className="mt-3 text-center text-[10px] text-[var(--text-faint)]">
          本项目仅供学习交流使用，请遵守当地法律法规。<a href="https://github.com/0xNullAI/DG-Chat" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--accent)]">GitHub</a>
        </p>
      </div>
    </div>
  );
}
