import { useState } from 'react';
import { Button, Input, Overlay } from '@0xnullai/ui';

/**
 * Create a room.
 *
 * Split out of the old full-page entry card — that card handled three things at once
 * (enter a nickname, create a room, join a room), so every time you opened Chat you had to
 * work through a form first. The nickname now comes from the account and joining goes
 * through the room list in the sidebar, so only "create a room" is left here.
 *
 * Creating is also what claims the room: the server mints an owner key for whoever creates it
 * and this browser keeps it. No account is involved — that is the point — so the settings
 * below are only the *initial* ones; the owner can change them later from the room header.
 */

function newRoomCode(): string {
  // crypto instead of Math.random: the room code is the only admission credential a private
  // room has, and a predictable one is the same as no credential at all.
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes]
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 10);
}

export function CreateRoomDialog({
  defaultName,
  onCreate,
  onClose,
}: {
  defaultName: string;
  onCreate: (code: string, options: { public: boolean; roomName?: string }) => void;
  onClose: () => void;
}) {
  const [isPublic, setIsPublic] = useState(false);
  const [roomName, setRoomName] = useState('');

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="建房间"
        className="w-[min(400px,calc(100vw-2rem))] rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow-panel)]"
      >
        <h2 className="text-lg font-semibold">建房间</h2>

        <label className="mt-5 flex cursor-pointer items-start justify-between gap-4 rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3">
          <span className="min-w-0">
            <span className="block text-sm">公开到大厅</span>
            <span className="block text-xs text-[var(--text-faint)]">
              关闭 = 私密房间，只有拿到房间号的人能进；建好后房主随时可改
            </span>
          </span>
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="mt-0.5 shrink-0 accent-[var(--accent)]"
          />
        </label>

        {/* Asked for whether or not the room is public: a room persists now and shows up in
            your own sidebar forever, and a list of ten-character codes is unreadable. */}
        <label className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">房间名</span>
          <Input
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            placeholder={defaultName || '未命名房间'}
          />
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => {
              onCreate(newRoomCode(), {
                public: isPublic,
                roomName: roomName.trim() || defaultName,
              });
              onClose();
            }}
          >
            创建
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
