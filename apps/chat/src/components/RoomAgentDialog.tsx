import { useEffect, useRef, useState } from 'react';
import { Bot, Trash2 } from 'lucide-react';
import { Overlay } from '@0xnullai/ui';
import { loadScenes, savedPromptKind, subscribeScenes, type SavedScene } from '@0xnullai/scenes';
import { characterCardContext } from '@0xnullai/scenes/character-card';
import {
  MAX_GROUP_AGENTS,
  MAX_ROOM_AGENT_NAME,
  MAX_ROOM_AGENT_PERSONA,
  type WireRoomAgent,
} from '../../worker/wire';

/** The persona a character carries into a group: its prompt plus its public card. */
export function groupPersona(character: SavedScene): string {
  return [character.prompt.trim(), characterCardContext(character.characterCard)]
    .filter(Boolean)
    .join('\n\n');
}

function myCharacters(): SavedScene[] {
  const library = loadScenes();
  return library.scenes.filter(
    (entry) =>
      !library.hiddenBuiltinIds.includes(entry.id) && savedPromptKind(entry) === 'character',
  );
}

/**
 * The group's AIs. Each belongs to the member who brought it in: one of their own characters,
 * answering whoever @-mentions it and paid from that member's Credit. Members bring or
 * withdraw their own; the group's owner may remove anyone's. Nothing here is a model or key
 * setting — group AIs always use the platform model.
 */
export function RoomAgentDialog({
  agents,
  selfAccountId,
  canRemoveAny,
  onAdd,
  onSetDailyCap,
  onRemove,
  onClose,
}: {
  agents: WireRoomAgent[];
  selfAccountId: string | null;
  canRemoveAny: boolean;
  onAdd: (character: { id: string; name: string; persona: string }) => Promise<boolean>;
  onSetDailyCap: (agentId: string, dailyCap: number | null) => void;
  onRemove: (agentId: string) => void;
  onClose: () => void;
}) {
  const [characters, setCharacters] = useState<SavedScene[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    const apply = () => setCharacters(myCharacters());
    apply();
    return subscribeScenes(apply);
  }, []);
  const mine = agents.find((agent) => agent.owner === selfAccountId);
  const full = agents.length >= MAX_GROUP_AGENTS;

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
            群 AI
          </h2>
        </div>
        <p className="text-xs text-[var(--text-soft)]">
          每人可以把自己的一个角色带进群。任何成员都能 @ 它，回复使用带它进群那个人的
          Credit；不会读取任何人的私人记忆。
        </p>

        {agents.length > 0 && (
          <ul className="flex flex-col divide-y divide-[var(--surface-border)] rounded-[var(--radius-md)] border border-[var(--surface-border)]">
            {agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                isMine={agent.owner === selfAccountId}
                canRemove={agent.owner === selfAccountId || canRemoveAny}
                onSetDailyCap={onSetDailyCap}
                onRemove={onRemove}
              />
            ))}
          </ul>
        )}

        {!mine && !full && (
          <section className="flex flex-col gap-2" aria-label="带我的角色进群">
            <h3 className="text-sm font-medium">带我的角色进群</h3>
            {characters.length === 0 ? (
              <p className="text-xs text-[var(--text-faint)]">
                还没有角色。先在「发现」或角色库里添加一个角色，再回来带它进群。
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {characters.map((character) => {
                  const persona = groupPersona(character);
                  const tooLong =
                    persona.length > MAX_ROOM_AGENT_PERSONA ||
                    character.name.trim().length > MAX_ROOM_AGENT_NAME;
                  return (
                    <button
                      key={character.id}
                      type="button"
                      disabled={tooLong || adding !== null}
                      onClick={async () => {
                        setAdding(character.id);
                        await onAdd({ id: character.id, name: character.name.trim(), persona });
                        setAdding(null);
                      }}
                      className="flex min-h-11 items-center gap-2 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] px-3 text-left text-sm transition-colors hover:border-[var(--accent)] disabled:opacity-50"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {character.icon ? `${character.icon} ` : ''}
                        {character.name}
                      </span>
                      <span className="shrink-0 text-xs text-[var(--text-faint)]">
                        {tooLong
                          ? '人设过长，暂不能带进群'
                          : adding === character.id
                            ? '正在加入…'
                            : '带进群'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}
        {!mine && full && (
          <p className="text-xs text-[var(--text-faint)]">本群已有 {MAX_GROUP_AGENTS} 个 AI。</p>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] px-3 py-2 text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
          >
            完成
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function AgentRow({
  agent,
  isMine,
  canRemove,
  onSetDailyCap,
  onRemove,
}: {
  agent: WireRoomAgent;
  isMine: boolean;
  canRemove: boolean;
  onSetDailyCap: (agentId: string, dailyCap: number | null) => void;
  onRemove: (agentId: string) => void;
}) {
  const [cap, setCap] = useState(agent.dailyCap === null ? '' : String(agent.dailyCap));
  // Compare with what was last sent, not the prop: the server's echo may not have arrived yet.
  const sent = useRef(agent.dailyCap);
  const saveCap = () => {
    const trimmed = cap.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (!Number.isFinite(next) || next < 0)) return;
    if (next === sent.current) return;
    sent.current = next;
    onSetDailyCap(agent.id, next);
  };
  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">
          {agent.name}
          <span className="text-[var(--text-faint)]">
            {' '}
            · {isMine ? '我' : agent.ownerName}的 AI
          </span>
        </span>
        {canRemove && (
          <button
            type="button"
            onClick={() => onRemove(agent.id)}
            className="flex shrink-0 items-center gap-1 rounded-[var(--radius-ctl)] px-2 py-1 text-xs text-[var(--danger)] hover:bg-[var(--danger-soft)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {isMine ? '撤出' : '移出'}
          </button>
        )}
      </div>
      {isMine && (
        <label className="flex items-center gap-2 text-xs text-[var(--text-soft)]">
          每日 Credit 上限
          <input
            inputMode="decimal"
            value={cap}
            placeholder="不限"
            onChange={(event) => setCap(event.target.value)}
            onBlur={saveCap}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveCap();
            }}
            className="w-24 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-2 py-1 text-sm outline-none focus:border-[var(--accent)]"
          />
        </label>
      )}
    </li>
  );
}
