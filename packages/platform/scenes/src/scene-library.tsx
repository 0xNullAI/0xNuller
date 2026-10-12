import { CharacterCardFields } from './character-card-fields.js';
import { parseCharacterCard } from './character-card.js';
import { importExternalCardFile } from './external-card-container.js';
import { useEffect, useRef, useState } from 'react';
import {
  canImportLegacyScenes,
  importLegacyScenes,
  importMarketSceneOnline,
  legacyScenesToImportCount,
  loadScenes,
  newSceneId,
  savedPromptKind,
  syncScenes,
  withImportedMarketScene,
  withUpdatedMarketScene,
  type SavedScene,
} from './index.js';
import type { CharacterCard } from './character-card.js';
import { useScenes } from './use-scenes.js';
import { ScriptSplitterDialog } from './script-splitter-dialog.js';
import { SPLIT_MIN_PROMPT_LENGTH, type ScriptSource } from './script-splitter.js';
import {
  Check,
  FileUp,
  MessageCircle,
  Pencil,
  Plus,
  RotateCcw,
  Scissors,
  Store,
  Trash2,
} from 'lucide-react';
import {
  Button,
  Input,
  Textarea,
  MarketImportDialog,
  Z_LOCAL_POPOVER,
  cn,
  SegmentedControl,
} from '@0xnullai/ui';
import { fetchMarketItem, type MarketItem } from '@0xnullai/market-client';
import { currentAuthUserId } from '@0xnullai/auth';

const DEFAULT_CUSTOM_ICON = '📝';
/** Editor id for a card that does not exist yet; never a valid saved id. */
const NEW_CARD_ID = '\u0000new';
const CARD_FILE_TYPES = '.json,.png,.apng,.charx,application/json,image/png';

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

interface SceneLibraryProps {
  /** Notification after a successful delete. The delete itself runs directly against the shared library. */
  onNotify?: (message: string) => void;
  /** Open a chat with this card; the host decides how (character chat or scene-only chat). */
  onStartChat?: (preset: SavedScene) => void;
}

export function SceneLibrary({ onNotify, onStartChat }: SceneLibraryProps) {
  // The library moved out of Agent's settings blob: shared across modules
  // (Voice sees the same set), and one corrupt scene no longer reverts the
  // whole settings blob to defaults — the strength caps lived in that blob
  // too.
  const [scenes, updateScenes] = useScenes();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<'character' | 'scene'>('character');
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [kindFilter, setKindFilter] = useState<'all' | 'character' | 'scene'>('all');
  const [query, setQuery] = useState('');
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState(DEFAULT_CUSTOM_ICON);
  const [editPrompt, setEditPrompt] = useState('');
  const [editCharacterCard, setEditCharacterCard] = useState<CharacterCard>();
  const [marketOpen, setMarketOpen] = useState(false);
  const [splitSource, setSplitSource] = useState<ScriptSource | null>(null);
  const [splitBusy, setSplitBusy] = useState<string | null>(null);
  const [marketUpdateBusy, setMarketUpdateBusy] = useState<string | null>(null);
  const [marketUpdateError, setMarketUpdateError] = useState('');
  const [marketUpdateNotice, setMarketUpdateNotice] = useState('');
  const [marketUpdate, setMarketUpdate] = useState<{
    sceneId: string;
    expectedScene: string;
    item: MarketItem;
  } | null>(null);
  const accountGeneration = useRef(0);
  const account = useRef(currentAuthUserId());
  useEffect(() => {
    const reset = () => {
      const nextAccount = currentAuthUserId();
      if (account.current === nextAccount) return;
      account.current = nextAccount;
      accountGeneration.current += 1;
      setEditingId(null);
      setMarketUpdate(null);
      setMarketUpdateBusy(null);
      setMarketUpdateError('');
      setMarketUpdateNotice('');
      setSplitSource(null);
      setSplitBusy(null);
    };
    window.addEventListener('0xnullai:auth-changed', reset);
    return () => window.removeEventListener('0xnullai:auth-changed', reset);
  }, []);

  function selectPreset(id: string) {
    updateScenes((current) => ({ ...current, selectedId: id }));
  }

  function startEdit(preset: SavedScene) {
    setEditingId(preset.id);
    setEditName(preset.name);
    setEditIcon(preset.icon ?? DEFAULT_CUSTOM_ICON);
    setEditPrompt(preset.prompt);
    setEditCharacterCard(preset.characterCard);
  }

  function startCreate(kind: 'character' | 'scene') {
    setNewMenuOpen(false);
    setNewKind(kind);
    setEditingId(NEW_CARD_ID);
    setEditName('');
    setEditIcon(kind === 'character' ? '🎭' : DEFAULT_CUSTOM_ICON);
    setEditPrompt('');
    setEditCharacterCard(undefined);
  }

  function saveEdit() {
    if (
      !editingId ||
      !editName.trim() ||
      (editCharacterCard && !parseCharacterCard(editCharacterCard))
    )
      return;
    if (editingId === NEW_CARD_ID) {
      // A card made here is private: it lives only in this account's library.
      const created: SavedScene = {
        id: newSceneId(),
        kind: newKind,
        name: editName.trim(),
        icon: editIcon,
        prompt: editPrompt,
        ...(newKind === 'character' && editCharacterCard
          ? { characterCard: editCharacterCard }
          : {}),
      };
      updateScenes((current) => ({ ...current, scenes: [created, ...current.scenes] }));
      setEditingId(null);
      onNotify?.(newKind === 'character' ? '已新建角色' : '已新建场景');
      return;
    }
    updateScenes((current) => ({
      ...current,
      scenes: current.scenes.map((p) =>
        p.id === editingId
          ? {
              ...p,
              // The card type is fixed: a legacy prompt without `kind` would otherwise turn
              // into a character (and gain memory) when a card is added, or the reverse.
              kind: savedPromptKind(p),
              name: editName.trim(),
              icon: editIcon,
              prompt: editPrompt,
              characterCard: editCharacterCard,
            }
          : p,
      ),
    }));
    setEditingId(null);
  }

  function deletePreset(id: string) {
    updateScenes((current) => {
      const remaining = current.scenes.filter((scene) => scene.id !== id);
      return {
        ...current,
        scenes: remaining,
        selectedId: current.selectedId === id ? (remaining[0]?.id ?? '') : current.selectedId,
      };
    });
    onNotify?.('已删除个人内容');
  }

  async function importFromMarket(item: MarketItem) {
    const importingAccount = currentAuthUserId();
    if (!importingAccount) throw new Error('请先登录后导入公开内容');
    // A list result may outlive moderation or an author's latest revision.
    const latest = await fetchMarketItem(item.id);
    if (currentAuthUserId() !== importingAccount) throw new Error('账号已切换，请重新打开公开内容');
    const preview = withImportedMarketScene(
      { scenes: [], selectedId: '', hiddenBuiltinIds: [] },
      latest,
    ).scenes[0];
    if (!preview) throw new Error('公开卡内容无效，无法导入');
    await importMarketSceneOnline(latest, { select: savedPromptKind(preview) === 'character' });
  }

  async function importFromFile(file: File) {
    const importingAccount = currentAuthUserId();
    setMarketUpdateError('');
    setMarketUpdateNotice('');
    if (!importingAccount) {
      setMarketUpdateError('请先登录后导入角色文件');
      return;
    }
    setFileBusy(true);
    try {
      const imported = await importExternalCardFile(file);
      if (currentAuthUserId() !== importingAccount) throw new Error('账号已切换，请重新导入');
      if (!imported.name.trim()) throw new Error('角色文件缺少名称');
      const created: SavedScene = {
        id: newSceneId(),
        kind: 'character',
        name: imported.name.trim(),
        icon: '🎭',
        prompt: imported.prompt,
        ...(parseCharacterCard(imported.card) ? { characterCard: imported.card } : {}),
      };
      updateScenes((current) => ({ ...current, scenes: [created, ...current.scenes] }));
      const notice = [`已导入角色「${created.name}」`, ...imported.warnings].join('；');
      setMarketUpdateNotice(notice);
      onNotify?.(`已导入角色「${created.name}」`);
    } catch (error) {
      setMarketUpdateError(error instanceof Error ? error.message : '角色文件导入失败');
    } finally {
      setFileBusy(false);
    }
  }

  async function importFromOldBrowserLibrary() {
    const currentAccount = currentAuthUserId();
    if (!currentAccount) return;
    await syncScenes();
    if (currentAuthUserId() !== currentAccount) return;
    if (!canImportLegacyScenes()) {
      setMarketUpdateError('云端卡片暂不可用，旧卡仍保留在这台设备上');
      return;
    }
    const count = importLegacyScenes();
    if (!count) return;
    const notice = `已将 ${count} 张旧卡加入当前账号，正在同步`;
    setMarketUpdateNotice(notice);
    onNotify?.(notice);
  }

  /**
   * The source of a split decides attribution. A card imported from 发现 or adapted from one is
   * someone else's work; only the public author is fetched, the script stays the local copy.
   */
  async function startSplit(scene: SavedScene) {
    const generation = accountGeneration.current;
    const base = { name: scene.name, prompt: scene.prompt };
    if (scene.derivedFrom) {
      setSplitSource({
        ...base,
        author: scene.characterCard?.creator ?? '',
        derivedFrom: scene.derivedFrom,
      });
      return;
    }
    if (!scene.id.startsWith('market-')) {
      setSplitSource({ ...base, author: scene.characterCard?.creator || '我' });
      return;
    }
    const itemId = scene.id.slice('market-'.length);
    setSplitBusy(scene.id);
    const author = await fetchMarketItem(itemId)
      .then((item) => item.author?.trim() ?? '')
      .catch(() => '');
    if (generation !== accountGeneration.current) return;
    setSplitBusy(null);
    setSplitSource({
      ...base,
      author: author || scene.characterCard?.creator || '',
      derivedFrom: { itemId, name: scene.name },
    });
  }

  async function checkMarketUpdate(scene: SavedScene) {
    if (!scene.id.startsWith('market-')) return;
    const itemId = scene.id.slice('market-'.length);
    const generation = accountGeneration.current;
    setMarketUpdateBusy(scene.id);
    setMarketUpdate(null);
    setMarketUpdateError('');
    setMarketUpdateNotice('');
    try {
      const item = await fetchMarketItem(itemId);
      if (generation !== accountGeneration.current) return;
      const revision = item.revision;
      if (item.type !== 'scenario' || !Number.isSafeInteger(revision) || !revision)
        throw new Error('公开卡版本暂不可用');
      if (scene.marketRevision && revision <= scene.marketRevision) {
        setMarketUpdateNotice('已是当前公开版本');
        onNotify?.('已是当前公开版本');
        return;
      }
      setMarketUpdate({ sceneId: scene.id, expectedScene: JSON.stringify(scene), item });
    } catch (error) {
      if (generation === accountGeneration.current)
        setMarketUpdateError(error instanceof Error ? error.message : '检查公开更新失败');
    } finally {
      if (generation === accountGeneration.current) setMarketUpdateBusy(null);
    }
  }

  function acceptMarketUpdate() {
    if (!marketUpdate) return;
    const currentLibrary = loadScenes();
    const currentScene = currentLibrary.scenes.find((scene) => scene.id === marketUpdate.sceneId);
    if (!currentScene || JSON.stringify(currentScene) !== marketUpdate.expectedScene) {
      setMarketUpdateError('此内容已在其他窗口修改，请重新检查公开版本');
      setMarketUpdateNotice('');
      setMarketUpdate(null);
      return;
    }
    const kind = savedPromptKind(currentScene);
    const updated = withUpdatedMarketScene(currentLibrary, marketUpdate.item);
    if (updated === currentLibrary) {
      setMarketUpdateError('公开卡类型或版本不匹配，未采用更新');
      setMarketUpdate(null);
      return;
    }
    updateScenes((current) => withUpdatedMarketScene(current, marketUpdate.item));
    setMarketUpdate(null);
    setMarketUpdateError('');
    const notice =
      kind === 'character'
        ? '已采用新版公开人设；专属称呼、记忆和聊天记录不变'
        : '已采用新版公开场景；已有聊天记录不变';
    setMarketUpdateNotice(notice);
    onNotify?.(notice);
  }

  const legacyCount = legacyScenesToImportCount();
  const needle = query.trim().toLowerCase();
  const visibleScenes = scenes.scenes.filter(
    (preset) =>
      // The card being edited stays visible even if the edit stops matching the filter.
      preset.id === editingId ||
      ((kindFilter === 'all' || savedPromptKind(preset) === kindFilter) &&
        (!needle || preset.name.toLowerCase().includes(needle))),
  );
  const renderEditor = (key: string, kind: 'character' | 'scene') => (
    <div
      key={key}
      className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--bg-strong)] p-3"
    >
      <div className="flex gap-2">
        <EmojiPicker value={editIcon} onChange={setEditIcon} />
        <Input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          placeholder={kind === 'character' ? '角色名称' : '场景名称'}
          className="text-sm"
        />
      </div>
      <Textarea
        value={editPrompt}
        onChange={(e) => setEditPrompt(e.target.value)}
        rows={4}
        placeholder={kind === 'character' ? '描述 AI 的人设和互动风格…' : '描述环境、规则和氛围…'}
        className="text-sm"
      />
      {kind === 'character' ? (
        <details>
          <summary className="cursor-pointer text-sm">结构化角色卡</summary>
          <CharacterCardFields value={editCharacterCard} onChange={setEditCharacterCard} />
        </details>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={saveEdit}
          disabled={Boolean(
            !editName.trim() || (editCharacterCard && !parseCharacterCard(editCharacterCard)),
          )}
        >
          保存
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
          取消
        </Button>
      </div>
    </div>
  );
  return (
    <div className="settings-panel-tab-content">
      <div className="flex flex-col gap-3">
        {legacyCount > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void importFromOldBrowserLibrary()}>
            导入这台设备上的旧卡（{legacyCount}）
          </Button>
        )}
        {marketUpdateError && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {marketUpdateError}
          </p>
        )}
        {marketUpdateNotice && (
          <p role="status" className="text-sm text-[var(--text-soft)]">
            {marketUpdateNotice}
          </p>
        )}
        {scenes.scenes.length > 0 && (
          <div className="flex items-center gap-2">
            <SegmentedControl
              label="类型"
              value={kindFilter}
              onChange={setKindFilter}
              options={[
                ['all', '全部'],
                ['character', '角色'],
                ['scene', '场景'],
              ]}
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称"
              aria-label="搜索角色与场景"
              className="h-9 min-w-0 flex-1 text-sm"
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={newMenuOpen}
            disabled={editingId === NEW_CARD_ID}
            onClick={() => setNewMenuOpen((open) => !open)}
          >
            <Plus className="h-4 w-4" />
            新建
          </Button>
          {newMenuOpen && (
            <>
              <Button variant="secondary" size="sm" onClick={() => startCreate('character')}>
                新建角色
              </Button>
              <Button variant="secondary" size="sm" onClick={() => startCreate('scene')}>
                新建场景
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={fileBusy}
            onClick={() => fileInput.current?.click()}
          >
            <FileUp className="h-4 w-4" />
            {fileBusy ? '导入中…' : '导入文件'}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept={CARD_FILE_TYPES}
            aria-label="导入 CCv2／CCv3 角色文件"
            className="hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void importFromFile(file);
              event.currentTarget.value = '';
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label="从 Market 导入"
            onClick={() => setMarketOpen(true)}
          >
            <Store className="h-4 w-4" />
            导入
          </Button>
        </div>
        {editingId === NEW_CARD_ID && renderEditor(NEW_CARD_ID, newKind)}
        {scenes.scenes.length === 0 && editingId !== NEW_CARD_ID && (
          <div className="py-4 text-center text-sm text-[var(--text-faint)]">
            还没有角色或场景。可新建、导入文件，或从发现导入公开卡。
          </div>
        )}
        {scenes.scenes.length > 0 && visibleScenes.length === 0 && (
          <p className="py-4 text-center text-sm text-[var(--text-faint)]">没有匹配的卡片</p>
        )}

        <div className="space-y-1.5">
          {visibleScenes.map((preset) => {
            if (editingId === preset.id) return renderEditor(preset.id, savedPromptKind(preset));
            const active = scenes.selectedId === preset.id;

            return (
              <div key={preset.id}>
                <div
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
                      <div className={cn('truncate text-sm', active && 'font-medium')}>
                        {preset.name}
                      </div>
                      <div className="truncate text-[11px] text-[var(--text-faint)]">
                        <span>{savedPromptKind(preset) === 'character' ? '角色' : '场景'}</span>
                        {' · '}
                        <span>
                          {preset.id.startsWith('market-')
                            ? `来自发现${preset.marketRevision ? ` · v${preset.marketRevision}` : ''}`
                            : preset.derivedFrom
                              ? `私有 · 改编自《${preset.derivedFrom.name}》`
                              : '私有'}
                        </span>
                      </div>
                    </div>
                  </button>
                  {onStartChat && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-[var(--text-soft)] hover:text-[var(--text)]"
                      aria-label={`和 ${preset.name} 聊天`}
                      onClick={() => onStartChat(preset)}
                    >
                      <MessageCircle className="h-3.5 w-3.5" />
                      聊天
                    </Button>
                  )}
                  {preset.prompt.length >= SPLIT_MIN_PROMPT_LENGTH && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 rounded-full text-[var(--text-faint)] hover:text-[var(--text)]"
                      aria-label={`拆分角色：${preset.name}`}
                      title="拆分角色"
                      disabled={splitBusy === preset.id}
                      onClick={() => void startSplit(preset)}
                    >
                      <Scissors className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {preset.id.startsWith('market-') && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 rounded-full text-[var(--text-faint)] hover:text-[var(--text)]"
                      aria-label={`检查 ${preset.name} 的公开更新`}
                      disabled={marketUpdateBusy === preset.id}
                      onClick={() => void checkMarketUpdate(preset)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 rounded-full text-[var(--text-faint)] hover:text-[var(--text)]"
                    aria-label={`编辑 ${preset.name}`}
                    onClick={() => startEdit(preset)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 rounded-full text-[var(--text-faint)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                    aria-label={`删除 ${preset.name}`}
                    onClick={() => deletePreset(preset.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  <span className="flex h-7 w-4 shrink-0 items-center justify-center">
                    {active && <Check className="h-4 w-4 text-[var(--accent)]" />}
                  </span>
                </div>
                {marketUpdate?.sceneId === preset.id && (
                  <div className="mx-3 mb-2 space-y-2 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-3 text-sm">
                    <p className="font-medium">
                      公开{savedPromptKind(preset) === 'character' ? '角色' : '场景'}有新版本：v
                      {preset.marketRevision ?? '?'} → v{marketUpdate.item.revision}
                    </p>
                    <p className="text-[var(--text-soft)]">
                      {savedPromptKind(preset) === 'character'
                        ? '采用后会替换人设快照和本地修改；角色 ID、专属称呼、记忆与聊天记录保持不变。'
                        : '采用后会替换场景快照和本地修改；已有聊天记录保持不变。'}
                    </p>
                    <p className="line-clamp-3 text-[var(--text-soft)]">
                      {'prompt' in marketUpdate.item.content
                        ? `${marketUpdate.item.content.prompt.slice(0, 400)}${marketUpdate.item.content.prompt.length > 400 ? '…' : ''}`
                        : ''}
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={acceptMarketUpdate}>
                        采用新版
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setMarketUpdate(null)}>
                        取消
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <MarketImportDialog
        open={marketOpen}
        onOpenChange={setMarketOpen}
        type="scenario"
        onImport={importFromMarket}
      />
      {splitSource && (
        <ScriptSplitterDialog
          source={splitSource}
          onClose={() => setSplitSource(null)}
          onStartChat={onStartChat}
          onSaved={(cards) => onNotify?.(`已保存 ${cards.length} 张私有卡`)}
        />
      )}
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
