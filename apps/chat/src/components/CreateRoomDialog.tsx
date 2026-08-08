import { useState } from 'react';
import { Button, Input, Overlay } from '@0xnullai/ui';

/**
 * 建房间。
 *
 * 从原来那张整页入口卡片里拆出来的——那张卡片同时承担「填昵称」「建房」「加入」
 * 三件事，于是每次打开 Chat 都要先过一遍表单。昵称现在来自账号，加入走侧边栏的
 * 房间列表，这里只剩「建房」这一件事。
 */

function newRoomCode(): string {
  // 用 crypto 而不是 Math.random：房间号是私密房唯一的准入凭证，可预测就等于没有。
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
        className="w-[min(400px,calc(100vw-2rem))] rounded-[20px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow-panel)]"
      >
        <h2 className="text-lg font-semibold">建房间</h2>

        <label className="mt-5 flex cursor-pointer items-start justify-between gap-4 rounded-[12px] border border-[var(--surface-border)] p-3">
          <span className="min-w-0">
            <span className="block text-sm">公开到大厅</span>
            <span className="block text-xs text-[var(--text-faint)]">
              关闭 = 私密房间，只有拿到房间号的人能进
            </span>
          </span>
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="mt-0.5 shrink-0 accent-[var(--accent)]"
          />
        </label>

        {isPublic && (
          <label className="mt-3 flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">房间名</span>
            <Input
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder={defaultName || '未命名房间'}
            />
          </label>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => {
              onCreate(newRoomCode(), {
                public: isPublic,
                ...(isPublic ? { roomName: roomName.trim() || defaultName } : {}),
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
