import { useState } from 'react';
import { X, Plus, Trash2, Crown, UserPlus, LogOut, Store, Bot } from 'lucide-react';
import type { Scene, SceneRole, MemberState } from '../lib/protocol';

interface SceneDialogProps {
  open: boolean;
  onClose: () => void;
  scene: Scene | null;
  roleAssignments: Record<string, string>;
  members: Map<string, MemberState>;
  selfId: string;
  selfName: string;
  isHost: boolean;
  onSetScene: (scene: Scene | null) => void;
  onClaimRole: (roleId: string) => void;
  onReleaseRole: (roleId: string) => void;
  /** 房主：把某 aiPlayable 角色交给 AI / 取消。 */
  onAssignAi: (roleId: string) => void;
  onReleaseAi: (roleId: string) => void;
  /** 打开「从市场导入场景」（Part C）。 */
  onImportFromMarket?: () => void;
}

function genId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function emptyDraft(): Scene {
  return { id: genId(), name: '', setting: '', roles: [{ id: genId(), name: '' }] };
}

export function SceneDialog({
  open, onClose, scene, roleAssignments, members, selfId, selfName,
  isHost, onSetScene, onClaimRole, onReleaseRole, onAssignAi, onReleaseAi, onImportFromMarket,
}: SceneDialogProps) {
  // 房主编辑态：null = 展示态；非 null = 编辑表单
  const [draft, setDraft] = useState<Scene | null>(null);

  if (!open) return null;

  function nameOf(peerId: string): string {
    if (peerId === selfId) return `${selfName || '我'}（我）`;
    return members.get(peerId)?.displayName || peerId.slice(0, 6);
  }

  // —— 房主编辑表单 ——
  function startEdit() {
    setDraft(scene ? { ...scene, roles: scene.roles.map(r => ({ ...r })) } : emptyDraft());
  }
  function updateRole(i: number, patch: Partial<SceneRole>) {
    setDraft(d => d && { ...d, roles: d.roles.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  }
  function addRole() {
    setDraft(d => d && { ...d, roles: [...d.roles, { id: genId(), name: '' }] });
  }
  function removeRole(i: number) {
    setDraft(d => d && { ...d, roles: d.roles.filter((_, idx) => idx !== i) });
  }
  function saveDraft() {
    if (!draft) return;
    const cleaned: Scene = {
      ...draft,
      name: draft.name.trim() || '未命名场景',
      roles: draft.roles
        .filter(r => r.name.trim())
        .map(r => ({ ...r, name: r.name.trim(), description: r.description?.trim() || undefined })),
    };
    if (cleaned.roles.length === 0) return;
    onSetScene(cleaned);
    setDraft(null);
  }

  const editing = draft !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label="房间场景"
        className="flex max-h-[85vh] w-[min(520px,calc(100vw-32px))] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow)]"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-[var(--surface-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--text)]">房间场景</h2>
            {isHost && (
              <span className="flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] text-[var(--accent)]">
                <Crown className="h-3 w-3" /> 房主
              </span>
            )}
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]" aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {editing && draft ? (
            /* —— 编辑表单（仅房主） —— */
            <div className="space-y-3">
              <input
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
                placeholder="场景名"
                className="w-full rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                style={{ fontSize: '16px' }}
              />
              <textarea
                value={draft.setting}
                onChange={e => setDraft({ ...draft, setting: e.target.value })}
                placeholder="世界观 / 背景设定（描述这个场景、氛围、规则…）"
                rows={4}
                className="w-full resize-none rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                style={{ fontSize: '16px' }}
              />
              <div className="space-y-2">
                <p className="text-xs text-[var(--text-soft)]">角色（成员各认领一个）</p>
                {draft.roles.map((r, i) => (
                  <div key={r.id} className="flex items-start gap-2">
                    <div className="flex-1 space-y-1">
                      <input
                        value={r.name}
                        onChange={e => updateRole(i, { name: e.target.value })}
                        placeholder={`角色 ${i + 1} 名字`}
                        className="w-full rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
                        style={{ fontSize: '16px' }}
                      />
                      <textarea
                        value={r.description ?? ''}
                        onChange={e => updateRole(i, { description: e.target.value })}
                        placeholder={r.aiPlayable ? '角色描述 / AI 人设（性格、口吻、动机…）' : '角色描述（可选）'}
                        rows={2}
                        className="w-full resize-none rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text-soft)] outline-none focus:border-[var(--accent)]"
                        style={{ fontSize: '16px' }}
                      />
                      <label className="flex items-center gap-1.5 text-xs text-[var(--text-soft)]">
                        <input
                          type="checkbox"
                          checked={!!r.aiPlayable}
                          onChange={e => updateRole(i, { aiPlayable: e.target.checked })}
                        />
                        <Bot size={12} /> 可由 AI 扮演（用上面的描述当人设）
                      </label>
                    </div>
                    <button
                      onClick={() => removeRole(i)}
                      disabled={draft.roles.length <= 1}
                      className="mt-1 flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-faint)] hover:text-[var(--danger)] disabled:opacity-30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button onClick={addRole} className="flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">
                  <Plus size={13} /> 加角色
                </button>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setDraft(null)} className="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)]">
                  取消
                </button>
                <button onClick={saveDraft} className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-[var(--button-text)] hover:opacity-90">
                  保存场景
                </button>
              </div>
            </div>
          ) : scene ? (
            /* —— 展示态：当前场景 + 角色认领 —— */
            <div className="space-y-3">
              <div>
                <p className="text-base font-semibold text-[var(--text)]">{scene.name}</p>
                {scene.setting && <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[var(--text-soft)]">{scene.setting}</p>}
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[var(--text-soft)]">角色</p>
                {scene.roles.map(role => {
                  const holder = roleAssignments[role.id];
                  const mine = holder === selfId;
                  const aiHeld = holder === `ai:${role.id}`;
                  return (
                    <div key={role.id} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-[var(--text)]">
                          {role.name}
                          {role.aiPlayable && <Bot size={12} className="shrink-0 text-[var(--text-faint)]" />}
                        </p>
                        {role.description && <p className="truncate text-xs text-[var(--text-faint)]">{role.description}</p>}
                      </div>
                      {aiHeld ? (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--accent)]">
                          <Bot size={12} /> AI
                          {isHost && (
                            <button onClick={() => onReleaseAi(role.id)} className="ml-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-1.5 py-0.5 text-[var(--text-soft)] hover:text-[var(--danger)]">
                              取消
                            </button>
                          )}
                        </span>
                      ) : holder ? (
                        mine ? (
                          <button onClick={() => onReleaseRole(role.id)} className="flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-2.5 py-1 text-xs text-[var(--text-soft)] hover:text-[var(--danger)]">
                            <LogOut size={12} /> 释放
                          </button>
                        ) : (
                          <span className="shrink-0 truncate text-xs text-[var(--text-faint)]">{nameOf(holder)}</span>
                        )
                      ) : (
                        <div className="flex shrink-0 items-center gap-1">
                          <button onClick={() => onClaimRole(role.id)} className="flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--accent-soft)] px-2.5 py-1 text-xs text-[var(--accent)] hover:opacity-90">
                            <UserPlus size={12} /> 认领
                          </button>
                          {isHost && role.aiPlayable && (
                            <button onClick={() => onAssignAi(role.id)} className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-2 py-1 text-xs text-[var(--text-soft)] hover:border-[var(--accent)] hover:text-[var(--accent)]" title="交给 AI 扮演">
                              <Bot size={12} /> AI
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {isHost && (
                <div className="flex gap-2 pt-1">
                  <button onClick={startEdit} className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-3 py-1.5 text-sm text-[var(--text-soft)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
                    编辑场景
                  </button>
                  <button onClick={() => onSetScene(null)} className="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm text-[var(--text-faint)] hover:text-[var(--danger)]">
                    清除场景
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* —— 无场景 —— */
            <div className="py-6 text-center">
              <p className="text-sm text-[var(--text-soft)]">{isHost ? '还没有设定场景' : '房主还没设定场景'}</p>
              {isHost && (
                <div className="mt-4 flex flex-col items-center gap-2">
                  <button onClick={startEdit} className="flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--button-text)] hover:opacity-90">
                    <Plus size={15} /> 创建场景
                  </button>
                  {onImportFromMarket && (
                    <button onClick={onImportFromMarket} className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-4 py-2 text-sm text-[var(--text-soft)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
                      <Store size={14} /> 从市场导入场景
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
