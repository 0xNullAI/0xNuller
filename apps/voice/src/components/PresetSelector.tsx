import { useRef, useState } from 'react';
import { Check, EyeOff, FileText, Pencil, Plus, RotateCcw, Store, Trash2 } from 'lucide-react';
import { Button, Input, Textarea } from '@0xnullai/ui';
import { cn } from '@voice/lib/utils';
import { BUILTIN_PROMPT_PRESETS } from '@voice/lib/prompts';
import { newSceneId, type SavedScene } from '@0xnullai/scenes';
import { useScenes } from '@0xnullai/scenes/react';
import type { MarketItem, MarketScenarioContent } from '@0xnullai/market-client';
import type { VoiceSettings } from '@voice/lib/settings';
import { MarketImportDialog } from './MarketImportDialog';

const DEFAULT_CUSTOM_ICON = '📝';

// 沉浸式角色扮演场景的写作骨架，结构参照「地狱岛冒险」。点击「使用模板」
// 填入新建场景的内容框，玩家按【】占位提示替换为自己的设定即可。
const SCENE_TEMPLATE = `【世界观名称】（例如：地狱岛）

背景设定：用一两段话描述这个世界——时代、社会形态、核心氛围，以及玩家为什么会进入这个世界。

设备系统：描述郊狼电击器在这个世界里的"身份"，低到中强度代表什么（快感/奖励），高强度代表什么（惩罚/警告）。

身份与规则：玩家的身份/等级，升降级或奖惩的触发条件，必须遵守的硬性规则。

场景与节奏：列出几个主要场景，会随机发生什么，触发频率建议低一些。

叙述风格：全程第三人称，将玩家称为"你"，每次推进一点剧情，语气要像说话不是写文章。

重要规则（务必保留）：游戏内被电击时一定要同步真实郊狼设备的强度/频率变化；电击事件结束后记得同时关闭郊狼。任何"通电/加强/停止"都要通过设备工具真实执行，而不仅仅是文字描述。`;

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

interface PresetSelectorProps {
  settings: VoiceSettings;
  updateSettings: (updater: (prev: VoiceSettings) => VoiceSettings) => void;
}

/**
 * Ported from Agent's `PresetSelector.tsx`, adapted from its
 * draft/commit settings model to Voice's save-on-change one. Built-in
 * presets are selectable and hideable but never editable — only
 * user-created (`custom-*`) or market-imported (`market-*`) presets go
 * through `savedPromptPresets`, matching the "locked persona, code-owned
 * safety blocks" model `build-voice-instructions.ts` relies on.
 */
export function PresetSelector(_props: PresetSelectorProps) {
  // 场景库改用跨模块共享的 @0xnullai/scenes——Agent 里写的人设在这里能看到，
  // 反之亦然。内置人设仍各自保留（Voice 那七份为 TTS 重写过：短句、无 markdown）。
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
  const visibleBuiltins = BUILTIN_PROMPT_PRESETS.filter((p) => !hiddenIds.includes(p.id));

  function selectPreset(id: string) {
    updateScenes((prev) => ({ ...prev, selectedId: id }));
  }

  function hideBuiltin(id: string) {
    updateScenes((prev) => {
      const nextHidden = [...prev.hiddenBuiltinIds, id];
      let nextSelected = prev.selectedId;
      if (prev.selectedId === id) {
        const remaining = BUILTIN_PROMPT_PRESETS.filter((p) => !nextHidden.includes(p.id));
        nextSelected = remaining[0]?.id ?? prev.scenes[0]?.id ?? prev.selectedId;
      }
      return { ...prev, hiddenBuiltinIds: nextHidden, selectedId: nextSelected };
    });
  }

  function restoreBuiltins() {
    updateScenes((prev) => ({ ...prev, hiddenBuiltinIds: [] }));
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
    updateScenes((prev) => ({
      ...prev,
      scenes: prev.scenes.map((p) =>
        p.id === editingId
          ? { ...p, name: editName.trim(), icon: editIcon, prompt: editPrompt }
          : p,
      ),
    }));
    setEditingId(null);
  }

  function deletePreset(id: string) {
    updateScenes((prev) => ({
      ...prev,
      scenes: prev.scenes.filter((p) => p.id !== id),
      selectedId: prev.selectedId === id ? (BUILTIN_PROMPT_PRESETS[0]?.id ?? id) : prev.selectedId,
    }));
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
    // 不用 `custom-${Date.now()}`：两个模块的库合并时同一毫秒建的会撞 id，
    // 而查找是 find()——撞了是静默遮蔽，表现为某个场景「点了没反应」。
    const id = newSceneId();
    updateScenes((prev) => ({
      ...prev,
      selectedId: id,
      scenes: [...prev.scenes, { id, name: newName.trim(), icon: newIcon, prompt: newPrompt }],
    }));
    setCreating(false);
  }

  function importFromMarket(item: MarketItem) {
    const id = `market-${item.id}`;
    const prompt = (item.content as MarketScenarioContent).prompt;
    updateScenes((prev) => {
      if (prev.scenes.some((p) => p.id === id)) {
        return { ...prev, selectedId: id };
      }
      return {
        ...prev,
        selectedId: id,
        scenes: [
          ...prev.scenes,
          { id, name: item.name, icon: item.icon || DEFAULT_CUSTOM_ICON, prompt },
        ],
      };
    });
  }

  return (
    <>
      <section className="settings-row-card space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="settings-card-legend">内置场景</h3>
          {hiddenIds.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-[var(--text-faint)]"
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
                  'group flex w-full min-w-0 items-center gap-2 rounded-[10px] px-3 py-2.5 transition-colors',
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
                    <div className="mt-0.5 truncate text-[12px] text-[var(--text-faint)]">
                      {preset.description}
                    </div>
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

      <section className="settings-row-card space-y-2">
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
                  className="space-y-2 rounded-[12px] border border-[var(--accent)] bg-[var(--bg-strong)] p-3"
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
                  'group flex w-full min-w-0 items-center gap-2 rounded-[10px] px-3 py-2.5 transition-colors',
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
          <div className="space-y-2 rounded-[12px] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-3">
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
              placeholder="描述 AI 的人设和互动风格…"
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
          <div className="flex gap-2">
            <Button
              variant="ghost"
              className="flex-1 justify-center gap-2 rounded-[10px] border border-dashed border-[var(--surface-border)] text-[var(--text-soft)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              onClick={startCreate}
            >
              <Plus className="h-4 w-4" />
              <span className="-mt-[0.1em] text-sm">新建场景</span>
            </Button>
            <Button
              variant="ghost"
              className="flex-1 justify-center gap-2 rounded-[10px] border border-dashed border-[var(--surface-border)] text-[var(--text-soft)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              onClick={() => setMarketOpen(true)}
            >
              <Store className="h-4 w-4" />
              <span className="-mt-[0.1em] text-sm">从市场导入</span>
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
    </>
  );
}

function EmojiPicker({ value, onChange }: { value: string; onChange: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg)] text-lg transition-colors hover:border-[var(--accent)]"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="选择图标"
      >
        {value}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 grid w-[188px] grid-cols-6 gap-0.5 rounded-[12px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1.5 shadow-lg">
          {EMOJI_OPTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-[6px] text-base transition-colors hover:bg-[var(--bg-soft)]',
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
