import { useEffect, useState } from 'react';
import { Bot, Trash2 } from 'lucide-react';
import { Overlay } from '@0xnullai/ui';
import { loadScenes, subscribeScenes, type SavedScene } from '@0xnullai/scenes';
import {
  MAX_ROOM_AGENT_NAME,
  MAX_ROOM_AGENT_PERSONA,
  ROOM_AGENT_ID,
  type NamedRoomAgent,
  type RoomAgent,
} from '../../worker/wire';

/**
 * Add or edit the room's AI participant.
 *
 * This is the entry point the kept feature never had: the AI used to be a
 * claimed scene role, so adding one meant opening the scene editor, defining
 * a cast, and handing one part to the AI. Now it is a name and a persona.
 *
 * Host-only, matching the server: the agent's device commands are authorized
 * on the host's authority.
 *
 * The persona can be picked from the shared scene library — the same one
 * Agent and Voice use — so a persona written once is available everywhere,
 * rather than being retyped per room. Picking one fills the text in; it is
 * still editable afterwards, because a room often wants a variation rather
 * than the library entry verbatim.
 */
export function RoomAgentDialog({
  agent,
  agents,
  onSaveAgents,
  billingMode = 'host-byok',
  onBillingModeChange,
  onSave,
  onClose,
}: {
  agent: RoomAgent | null;
  agents?: NamedRoomAgent[];
  onSaveAgents?: (agents: NamedRoomAgent[]) => void;
  billingMode?: 'host-byok' | 'managed';
  onBillingModeChange?: (mode: 'host-byok' | 'managed') => void;
  onSave: (next: RoomAgent | null) => void;
  onClose: () => void;
}) {
  const selected = agents ? (agents[0] ?? null) : agent;
  const save = (next: RoomAgent | null) => {
    if (!agents || !onSaveAgents) {
      onSave(next);
      return;
    }
    onSaveAgents(next ? [{ ...next, id: agents[0]?.id ?? ROOM_AGENT_ID }] : []);
  };
  const [name, setName] = useState(selected?.name ?? '');
  const [persona, setPersona] = useState(selected?.persona ?? '');
  const [scenes, setScenes] = useState<SavedScene[]>([]);

  useEffect(() => {
    const apply = () => {
      const lib = loadScenes();
      setScenes(lib.scenes.filter((s) => !lib.hiddenBuiltinIds.includes(s.id)));
    };
    apply();
    return subscribeScenes(apply);
  }, []);

  const trimmedName = name.trim();
  const nameTooLong = trimmedName.length > MAX_ROOM_AGENT_NAME;
  const personaTooLong = persona.length > MAX_ROOM_AGENT_PERSONA;
  const canSave = !!trimmedName && !nameTooLong && !personaTooLong;

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-agent-title"
        className="flex max-h-[calc(100dvh-2rem)] w-[min(520px,100%)] flex-col gap-4 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-panel)]"
      >
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[var(--accent)]" />
          <h2 id="room-agent-title" className="text-base font-semibold">
            房间 AI
          </h2>
        </div>

        <p className="text-xs text-[var(--text-soft)]">
          每群仅有一位 AI，只有真人 @ 时回应；不会读取成员的个人记忆。
        </p>
        {onBillingModeChange && (
          <label className="flex flex-col gap-1.5 text-xs text-[var(--text-soft)]">
            群 AI 模式
            <select
              value={billingMode}
              onChange={(event) =>
                onBillingModeChange(event.target.value as 'host-byok' | 'managed')
              }
              className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm"
            >
              <option value="host-byok">房主自带密钥（支持设备工具）</option>
              <option value="managed">平台托管（@ 发起人支付 Credit，仅文字）</option>
            </select>
            {billingMode === 'managed'
              ? '每次 @ 群 AI 前由发起人账户预留 Credit，成功后按实际用量结算；此模式不调用设备工具。'
              : '由房主浏览器的自带密钥调用模型；不会从其他成员扣 Credit。'}
          </label>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">名字</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：小助手"
            className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
        </label>

        {scenes.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">从场景库选一个</span>
            <div className="flex flex-wrap gap-1.5">
              {scenes.map((scene) => (
                <button
                  key={scene.id}
                  type="button"
                  onClick={() => {
                    setPersona(scene.prompt);
                    if (!trimmedName) setName(scene.name);
                  }}
                  className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] px-2.5 py-1 text-xs text-[var(--text-soft)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)]"
                >
                  {scene.icon ? `${scene.icon} ` : ''}
                  {scene.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">人设（可留空）</span>
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={6}
            placeholder="描述身份、语气和规则"
            className="resize-none rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm leading-relaxed outline-none focus:border-[var(--accent)]"
          />
        </label>

        {(nameTooLong || personaTooLong) && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            当前房间 AI 名字最多 {MAX_ROOM_AGENT_NAME} 个字符，人设最多 {MAX_ROOM_AGENT_PERSONA}
            个字符。导入的完整内容已保留，请编辑缩短后保存；原场景不会更改。
          </p>
        )}

        <div className="flex items-center justify-between gap-2">
          {selected ? (
            <button
              type="button"
              onClick={() => {
                save(null);
                onClose();
              }}
              className="flex items-center gap-1.5 rounded-[var(--radius-ctl)] px-3 py-2 text-sm text-[var(--danger)] transition-colors hover:bg-[var(--danger-soft)]"
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
              className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] px-3 py-2 text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => {
                if (!canSave) return;
                save({ name: trimmedName, persona });
                onClose();
              }}
              className="rounded-[var(--radius-ctl)] bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--button-text)] transition-opacity disabled:opacity-40"
            >
              {selected ? '保存' : '加入房间'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
