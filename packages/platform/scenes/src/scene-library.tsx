import { useRef, useState } from 'react';
import { newSceneId, type SavedScene } from './index.js';
import { useScenes } from './use-scenes.js';
import { Check, EyeOff, FileText, Pencil, Plus, RotateCcw, Store, Trash2 } from 'lucide-react';
import { Button, Input, Textarea, MarketImportDialog, Z_LOCAL_POPOVER, cn } from '@0xnullai/ui';
import type { MarketItem, MarketScenarioContent } from '@0xnullai/market-client';

const DEFAULT_CUSTOM_ICON = '📝';

// Writing skeleton for immersive role-play scenes, structured after the
// built-in "Hell Island" persona. "Use template" fills it into the new
// scene's body; players replace the 【】 placeholders with their own
// settings.
const SCENE_TEMPLATE = `# 【世界观名称】（例如：地狱岛）

## 背景设定
用一两段话描述这个世界：时代、社会形态、核心氛围，以及玩家为什么会进入这个世界、踏入后要遵守什么前提。

## 设备 / 电击系统
描述郊狼电击器在这个世界里的"身份"（某种装置、约束、契约道具……），以及：
- 低至中强度代表什么（快感 / 奖励 / 助兴）
- 高强度代表什么（惩罚 / 痛感 / 警告）
- 有哪些"配件"或玩法，分别对应身体的哪个部位

## 身份与规则
- 玩家的身份 / 等级 / 资源（金币、积分等）
- 升降级或奖惩的触发条件
- 必须遵守的硬性规则

## 场景 / 设施
列出几个主要场景，每个写清：能做什么、会触发什么电击玩法。

## 随机事件与节奏
- 会随机发生什么（佩戴新道具、被带走、强制表演……）
- 触发频率（建议低频，不要每轮都触发）
- 道具的获得与移除条件

## 开场指引
游戏开始时，先向玩家确认：拥有哪些配件、各配件多少强度是快感 / 多少是痛 / 上限是多少，然后以 1 的强度测试一次连接、确认无误后关闭。再在过程中自然地引导玩家补全姓名、性别、外貌、性格、敏感点等设定。

## 叙述风格
- 全程第三人称，将玩家称为"你"
- 每次对话推进一点剧情，不要太墨迹
- 说明色情 / 高强度场景的描写尺度

## 重要规则（务必保留）
游戏内被电击时一定要同步真实郊狼设备的强度 / 频率变化；电击事件结束后记得同时关闭郊狼。任何"通电 / 加强 / 停止"都要通过设备工具真实执行，而不仅仅是文字描述。`;

const EMOJI_OPTIONS = [
  '📝',
  '💕',
  '💖',
  '❤️',
  '🔥',
  '✨',
  '👑',
  '🌙',
  '⭐',
  '🎭',
  '💎',
  '⚡',
  '🌊',
  '🎵',
  '🌸',
  '🦋',
  '🌹',
  '🍓',
  '🎯',
  '💫',
  '🌟',
  '🐱',
  '🐰',
  '🎀',
  '🧸',
  '🌺',
  '🍷',
  '🗝️',
  '🌈',
  '🎪',
];

/** Built-in scenes can be selected and hidden here, never edited — their bodies are owned by code. */
export interface BuiltinScene {
  id: string;
  name: string;
  icon?: string;
  description?: string;
}

interface SceneLibraryProps {
  /**
   * Each module's own built-in scenes.
   *
   * The seven personas are the same set in Agent and Voice (ids / names /
   * icons match); only the bodies differ — Voice's are rewritten for
   * speech. Hence a prop rather than a hard import from one side: a hard
   * import shows the other side the wrong built-in list, an error visible
   * only by comparing the two modules item by item.
   */
  builtins: BuiltinScene[];
  /** Notification after a successful delete. The delete itself runs directly against the shared library. */
  onNotify?: (message: string) => void;
}

export function SceneLibrary({ builtins, onNotify }: SceneLibraryProps) {
  // The library moved out of Agent's settings blob: shared across modules
  // (Voice sees the same set), and one corrupt scene no longer reverts the
  // whole settings blob to defaults — the strength caps lived in that blob
  // too.
  const [scenes, updateScenes] = useScenes();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState(DEFAULT_CUSTOM_ICON);
  const [editPrompt, setEditPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState(DEFAULT_CUSTOM_ICON);
  const [newPrompt, setNewPrompt] = useState('');
  const [marketOpen, setMarketOpen] = useState(false);

  const hiddenIds = scenes.hiddenBuiltinIds;
  const visibleBuiltins = builtins.filter((p) => !hiddenIds.includes(p.id));

  function selectPreset(id: string) {
    updateScenes((current) => ({ ...current, selectedId: id }));
  }

  function hideBuiltin(id: string) {
    updateScenes((current) => {
      const nextHidden = [...current.hiddenBuiltinIds, id];
      // If the hidden one is the current selection, fall back to the first
      // still-visible built-in, then the first custom scene.
      let nextSelected = current.selectedId;
      if (current.selectedId === id) {
        const remaining = builtins.filter((p) => !nextHidden.includes(p.id));
        nextSelected = remaining[0]?.id ?? current.scenes[0]?.id ?? current.selectedId;
      }
      return { ...current, hiddenBuiltinIds: nextHidden, selectedId: nextSelected };
    });
  }

  function restoreBuiltins() {
    updateScenes((current) => ({ ...current, hiddenBuiltinIds: [] }));
  }

  function startEdit(preset: SavedScene) {
    setEditingId(preset.id);
    setEditName(preset.name);
    setEditIcon(preset.icon ?? DEFAULT_CUSTOM_ICON);
    setEditPrompt(preset.prompt);
    setCreating(false);
  }

  function saveEdit() {
    if (!editingId || !editName.trim()) return;
    updateScenes((current) => ({
      ...current,
      scenes: current.scenes.map((p) =>
        p.id === editingId
          ? { ...p, name: editName.trim(), icon: editIcon, prompt: editPrompt }
          : p,
      ),
    }));
    setEditingId(null);
  }

  function startCreate() {
    setCreating(true);
    setEditingId(null);
    setNewName('');
    setNewIcon(DEFAULT_CUSTOM_ICON);
    setNewPrompt('');
  }

  function confirmCreate() {
    if (!newName.trim()) return;
    // Not `custom-${Date.now()}`: merging two libraries collides ids
    // created in the same millisecond, and lookup is find() — a collision
    // is silent shadowing, a scene that "does nothing when clicked".
    const id = newSceneId();
    updateScenes((current) => ({
      ...current,
      selectedId: id,
      scenes: [...current.scenes, { id, name: newName.trim(), icon: newIcon, prompt: newPrompt }],
    }));
    setCreating(false);
    setNewName('');
    setNewIcon(DEFAULT_CUSTOM_ICON);
    setNewPrompt('');
  }

  function deletePreset(id: string) {
    updateScenes((current) => ({
      ...current,
      scenes: current.scenes.filter((p) => p.id !== id),
      // If the deleted one was selected, fall back to the first built-in.
      selectedId: current.selectedId === id ? 'gentle' : current.selectedId,
    }));
    onNotify?.('已删除该自定义场景');
  }

  function importFromMarket(item: MarketItem) {
    const id = `market-${item.id}`;
    const prompt = (item.content as MarketScenarioContent).prompt;
    updateScenes((current) => {
      if (current.scenes.some((p) => p.id === id)) {
        return { ...current, selectedId: id };
      }
      return {
        ...current,
        selectedId: id,
        scenes: [
          ...current.scenes,
          { id, name: item.name, icon: item.icon || DEFAULT_CUSTOM_ICON, prompt },
        ],
      };
    });
  }

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-card">
        <div className="flex items-center justify-between">
          <h3 className="settings-card-legend">内置场景</h3>
          {hiddenIds.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-[var(--text-faint)] hover:text-[var(--text)]"
              onClick={restoreBuiltins}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              恢复默认
            </Button>
          )}
        </div>
        <div className="space-y-1.5">
          {visibleBuiltins.map((preset) => {
            const active = scenes.selectedId === preset.id;
            return (
              <div
                key={preset.id}
                className={cn(
                  'group flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-ctl)] px-3 py-2.5 transition-colors',
                  active
                    ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]'
                    : 'hover:bg-[var(--bg-soft)]',
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => selectPreset(preset.id)}
                >
                  <span className="shrink-0 text-lg">{preset.icon ?? DEFAULT_CUSTOM_ICON}</span>
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-sm', active && 'font-medium')}>{preset.name}</div>
                    {preset.description && (
                      <div className="mt-0.5 truncate text-[12px] text-[var(--text-faint)]">
                        {preset.description}
                      </div>
                    )}
                  </div>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 rounded-full text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                  aria-label={`隐藏 ${preset.name}`}
                  onClick={() => hideBuiltin(preset.id)}
                >
                  <EyeOff className="h-3.5 w-3.5" />
                </Button>
                <span className="flex h-7 w-4 shrink-0 items-center justify-center">
                  {active && <Check className="h-4 w-4 text-[var(--accent)]" />}
                </span>
              </div>
            );
          })}
          {visibleBuiltins.length === 0 && (
            <div className="py-4 text-center text-sm text-[var(--text-faint)]">
              所有内置场景已隐藏，点击右上角"恢复默认"找回
            </div>
          )}
        </div>
      </section>

      <section className="settings-row-card">
        <h3 className="settings-card-legend">自定义场景</h3>
        {scenes.scenes.length === 0 && !creating && (
          <div className="py-4 text-center text-sm text-[var(--text-faint)]">
            还没有自定义场景，点击下方按钮创建
          </div>
        )}

        <div className="space-y-1.5">
          {scenes.scenes.map((preset) => {
            if (editingId === preset.id) {
              return (
                <div
                  key={preset.id}
                  className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--bg-strong)] p-3"
                >
                  <div className="flex gap-2">
                    <EmojiPicker value={editIcon} onChange={setEditIcon} />
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="场景名称"
                      className="text-sm"
                    />
                  </div>
                  <Textarea
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    rows={4}
                    placeholder="描述 AI 的人设和互动风格…"
                    className="text-sm"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveEdit}>
                      保存
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                      取消
                    </Button>
                  </div>
                </div>
              );
            }

            const active = scenes.selectedId === preset.id;

            return (
              <div
                key={preset.id}
                className={cn(
                  'group flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-ctl)] px-3 py-2.5 transition-colors',
                  active
                    ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]'
                    : 'hover:bg-[var(--bg-soft)]',
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => selectPreset(preset.id)}
                >
                  <span className="shrink-0 text-lg">{preset.icon ?? DEFAULT_CUSTOM_ICON}</span>
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-sm', active && 'font-medium')}>{preset.name}</div>
                  </div>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 rounded-full text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--text)]"
                  aria-label={`编辑 ${preset.name}`}
                  onClick={() => startEdit(preset)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 rounded-full text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                  aria-label={`删除 ${preset.name}`}
                  onClick={() => deletePreset(preset.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                <span className="flex h-7 w-4 shrink-0 items-center justify-center">
                  {active && <Check className="h-4 w-4 text-[var(--accent)]" />}
                </span>
              </div>
            );
          })}
        </div>

        {creating ? (
          <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-3">
            <div className="flex gap-2">
              <EmojiPicker value={newIcon} onChange={setNewIcon} />
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="场景名称"
                className="text-sm"
                autoFocus
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--text-faint)]">人设 / 互动风格</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 text-xs text-[var(--text-faint)] hover:text-[var(--accent)]"
                onClick={() => setNewPrompt(SCENE_TEMPLATE)}
              >
                <FileText className="h-3.5 w-3.5" />
                使用模板
              </Button>
            </div>
            <Textarea
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              rows={5}
              placeholder="描述 AI 的人设和互动风格…，或点击右上角「使用模板」从世界观骨架开始"
              className="text-sm"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={confirmCreate} disabled={!newName.trim()}>
                创建
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              variant="ghost"
              className="h-auto min-h-11 w-full justify-center gap-2 rounded-[var(--radius-ctl)] border border-dashed border-[var(--surface-border)] px-3 py-2.5 text-[var(--text-soft)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              onClick={startCreate}
            >
              <Plus className="h-4 w-4" />
              新建场景
            </Button>
            <Button
              variant="ghost"
              className="h-auto min-h-11 w-full justify-center gap-2 rounded-[var(--radius-ctl)] border border-dashed border-[var(--surface-border)] px-3 py-2.5 text-[var(--text-soft)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              onClick={() => setMarketOpen(true)}
            >
              <Store className="h-4 w-4" />
              从市场导入
            </Button>
          </div>
        )}
      </section>

      <MarketImportDialog
        open={marketOpen}
        onOpenChange={setMarketOpen}
        type="scenario"
        onImport={importFromMarket}
      />
    </div>
  );
}

function EmojiPicker({ value, onChange }: { value: string; onChange: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg)] text-lg transition-colors hover:border-[var(--accent)]"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="选择图标"
      >
        {value}
      </button>
      {open && (
        <div
          className={`absolute left-0 top-full ${Z_LOCAL_POPOVER} mt-1 grid w-[188px] grid-cols-6 gap-0.5 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1.5 shadow-[var(--shadow-panel)]`}
        >
          {EMOJI_OPTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-[var(--radius-xs)] text-base transition-colors hover:bg-[var(--bg-soft)]',
                value === emoji && 'bg-[var(--accent-soft)]',
              )}
              onClick={() => {
                onChange(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
