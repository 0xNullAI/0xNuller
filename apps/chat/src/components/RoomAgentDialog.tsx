import { useState } from 'react';
import { Bot, Trash2 } from 'lucide-react';
import { Overlay } from '@0xnullai/ui';
import type { RoomAgent } from '../../worker/wire';

/**
 * Add or edit the room's AI participant.
 *
 * This is the entry point the kept feature never had: the AI used to be a
 * claimed scene role, so adding one meant opening the scene editor, defining
 * a cast, and handing one part to the AI. Now it is a name and a persona.
 *
 * Host-only, matching the server: the agent's device commands are authorized
 * on the host's authority.
 */
export function RoomAgentDialog({
  agent,
  onSave,
  onClose,
}: {
  agent: RoomAgent | null;
  onSave: (next: RoomAgent | null) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [persona, setPersona] = useState(agent?.persona ?? '');

  const trimmedName = name.trim();

  return (
    <Overlay onDismiss={onClose}>
      <div className="flex w-[min(520px,100%)] flex-col gap-4 rounded-[16px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-panel)]">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[var(--accent)]" />
          <h2 className="text-base font-semibold">房间 AI</h2>
        </div>

        <p className="text-xs text-[var(--text-faint)]">
          加进房间之后，在消息里 @ 它就会回复。要让它控制谁的设备，得那个人自己点「允许AI」。
        </p>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">名字</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="例如：小助手"
            className="rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">人设（可留空）</span>
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            maxLength={4000}
            rows={6}
            placeholder="它是谁、说话什么风格、该做什么不该做什么。"
            className="resize-none rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm leading-relaxed outline-none focus:border-[var(--accent)]"
          />
        </label>

        <div className="flex items-center justify-between gap-2">
          {agent ? (
            <button
              type="button"
              onClick={() => {
                onSave(null);
                onClose();
              }}
              className="flex items-center gap-1.5 rounded-[10px] px-3 py-2 text-sm text-[var(--danger)] transition-colors hover:bg-[var(--danger-soft)]"
            >
              <Trash2 className="h-4 w-4" />
              移出房间
            </button>
          ) : (
            <span />
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[10px] border border-[var(--surface-border)] px-3 py-2 text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!trimmedName}
              onClick={() => {
                onSave({ name: trimmedName, persona });
                onClose();
              }}
              className="rounded-[10px] bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--button-text)] transition-opacity disabled:opacity-40"
            >
              {agent ? '保存' : '加入房间'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
