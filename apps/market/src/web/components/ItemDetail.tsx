import { requestProfileView, subscribeAuthChanges } from '@0xnullai/auth';
import { CharacterReportAction } from './CharacterReports';
import { FavoriteAction } from './FavoriteAction';
import { parseCharacterCard, type CharacterCard } from '@0xnullai/scenes/character-card';
import { CharacterCardFields } from '@0xnullai/scenes/character-editor';
import { scriptLengthError } from '../script-length';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Overlay } from '@0xnullai/ui';
import { ChevronLeft, MoreHorizontal, X } from 'lucide-react';
import type { ItemPatch, MarketItem, ScenarioContent, WaveformContent } from '../../shared/schema';
import { isExtraLargeScenario, promptKind } from '../../shared/schema';
import { MAX_SCENARIO_PROMPT_LENGTH } from '../../shared/schema';
import {
  characterPortraitUrl,
  deleteItem,
  fetchCreatorFollow,
  fetchItemAccess,
  saveCreatorFollow,
  updateItem,
  markDownloaded,
  tipItem,
  type CreatorFollowState,
} from '../api';
import { WaveformPreview } from './WaveformPreview';

interface Props {
  item: MarketItem;
  onClose: () => void;
  onUpdated?: (item: MarketItem) => void;
  onDeleted?: (id: string) => void;
  onEditCharacter?: (item: MarketItem) => void;
  onStartCharacter?: (item: MarketItem) => Promise<void>;
  onImportScene?: (item: MarketItem) => Promise<void>;
}

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ItemDetail({
  item,
  onClose,
  onUpdated,
  onDeleted,
  onEditCharacter,
  onStartCharacter,
  onImportScene,
}: Props): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  // Snapshot of the metadata currently on screen.
  const [viewOverride, setViewOverride] = useState<MarketItem | null>(null);
  const view = viewOverride ?? item;
  const [access, setAccess] = useState({ canEdit: false, canDelete: false });

  // —— edit state ——
  const [editing, setEditing] = useState(false);
  const [eName, setEName] = useState(item.name);
  const [eAuthor, setEAuthor] = useState(item.author ?? '');
  const [eDesc, setEDesc] = useState(item.description ?? '');
  const [eIcon, setEIcon] = useState(item.icon ?? '');
  const [eTags, setETags] = useState(item.tags.join(', '));
  const [ePrompt, setEPrompt] = useState(
    item.type === 'scenario' ? (item.content as ScenarioContent).prompt : '',
  );
  const [eCharacterCard, setECharacterCard] = useState<CharacterCard | undefined>(
    item.type === 'scenario' ? (item.content as ScenarioContent).characterCard : undefined,
  );
  const publicCard =
    view.type === 'scenario'
      ? parseCharacterCard((view.content as ScenarioContent).characterCard)
      : undefined;
  const isCharacter =
    view.type === 'scenario' && promptKind(view.content as ScenarioContent) === 'character';
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [importedScene, setImportedScene] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [follow, setFollow] = useState<CreatorFollowState | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetchItemAccess(item.id)
      .then((next) => active && setAccess(next))
      .catch(() => active && setAccess({ canEdit: false, canDelete: false }));
    return () => {
      active = false;
    };
  }, [item.id]);

  // Follow state is read here: the hero already shows @author, so only the
  // follow toggle remains, in the ⋯ menu.
  useEffect(() => {
    let live = true;
    fetchCreatorFollow(item.id)
      .then((next) => live && setFollow(next))
      .catch(() => live && setFollow(null));
    const stop = subscribeAuthChanges(() => {
      live = false;
      setFollow(null);
    });
    return () => {
      live = false;
      stop();
    };
  }, [item.id]);

  // Close the ⋯ menu on a press outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const hasIcon = view.type !== 'waveform';

  // The JSON shape Agent can import directly.
  const exportJson = JSON.stringify(
    view.type === 'waveform'
      ? {
          name: view.name,
          description: view.description,
          frames: (view.content as WaveformContent).frames,
          modality: (view.content as WaveformContent).modality ?? 'electrostimulation',
        }
      : { name: view.name, icon: view.icon, ...(view.content as ScenarioContent) },
    null,
    2,
  );

  const handleCopy = async () => {
    setCopyError('');
    setCopied(false);
    try {
      await navigator.clipboard.writeText(exportJson);
      setCopied(true);
      void markDownloaded(item.id);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError('复制失败，请重试或下载 .json 文件获取完整内容。');
    }
  };

  const handleDownload = () => {
    const safe = view.name.replace(/[^\w一-龥-]+/g, '_');
    download(`${safe}.json`, exportJson);
    void markDownloaded(item.id);
  };

  const handleTip = async () => {
    const value = window.prompt('输入打赏 Credit 数量（1–10000）');
    if (!value) return;
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount < 1 || amount > 10000) return;
    try {
      await tipItem(view.id, amount);
      window.alert('打赏成功');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '打赏失败');
    }
  };

  const handleStartCharacter = async () => {
    if (!onStartCharacter || starting) return;
    setStartError('');
    setStarting(true);
    try {
      await onStartCharacter(view);
    } catch (reason) {
      setStartError(reason instanceof Error ? reason.message : '暂时无法开始聊天');
    } finally {
      setStarting(false);
    }
  };

  const handleImportScene = async () => {
    if (!onImportScene || starting) return;
    setStartError('');
    setStarting(true);
    try {
      await onImportScene(view);
      setImportedScene(true);
    } catch (reason) {
      setStartError(reason instanceof Error ? reason.message : '暂时无法导入场景');
    } finally {
      setStarting(false);
    }
  };

  const startEdit = () => {
    setEName(view.name);
    setEAuthor(view.author ?? '');
    setEDesc(view.description ?? '');
    setEIcon(view.icon ?? '');
    setETags(view.tags.join(', '));
    if (view.type === 'scenario') {
      setEPrompt((view.content as ScenarioContent).prompt);
      setECharacterCard((view.content as ScenarioContent).characterCard);
    }
    setEditErr('');
    setEditing(true);
  };

  const saveEdit = async () => {
    setEditErr('');
    if (!eName.trim()) return setEditErr('名称不能为空');
    const lengthError = scriptLengthError({
      type: view.type,
      prompt: ePrompt,
    });
    if (lengthError) return setEditErr(lengthError);

    const tags = eTags
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);
    let content: ItemPatch['content'];
    if (view.type === 'scenario') {
      if (!ePrompt.trim()) return setEditErr('剧本内容不能为空');
      content = {
        prompt: ePrompt,
        kind: promptKind(view.content as ScenarioContent),
        ...(isCharacter ? { characterCard: eCharacterCard } : {}),
      };
    }

    const patch: ItemPatch = {
      expectedRevision: view.revision ?? 1,
      name: eName.trim(),
      author: eAuthor.trim(),
      description: eDesc.trim(),
      tags,
      ...(content ? { content } : {}),
      ...(hasIcon ? { icon: eIcon.trim() } : {}),
    };

    setSaving(true);
    try {
      await updateItem(item.id, patch);
      const updated: MarketItem = {
        ...view,
        name: patch.name!,
        author: patch.author || undefined,
        description: patch.description || undefined,
        icon: hasIcon ? eIcon.trim() || undefined : view.icon,
        tags,
        content: content ?? view.content,
        revision: (view.revision ?? 1) + 1,
      };
      setViewOverride(updated);
      onUpdated?.(updated);
      setEditing(false);
    } catch (e) {
      setEditErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('确定删除这条内容吗？')) return;
    setDeleting(true);
    setActionError('');
    try {
      await deleteItem(item.id);
      onDeleted?.(item.id);
      onClose();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '删除失败');
      setDeleting(false);
    }
  };

  const handleFollow = async () => {
    if (!follow?.creator || followBusy) return;
    setFollowBusy(true);
    setActionError('');
    try {
      await saveCreatorFollow(item.id, follow.creator.id, !follow.followed, follow.accountId);
      setFollow({ ...follow, followed: !follow.followed });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '关注失败');
    } finally {
      setFollowBusy(false);
    }
  };

  // Every ⋯ item closes the menu first, then acts.
  const fromMenu = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  const pulse = view.type === 'waveform' ? (view.content as WaveformContent).pulse : undefined;
  const primaryAction =
    isCharacter && onStartCharacter ? (
      <button
        className="btn primary ui-press"
        onClick={() => void handleStartCharacter()}
        disabled={starting}
      >
        {starting ? '正在打开聊天…' : '开始聊天'}
      </button>
    ) : view.type === 'scenario' && !isCharacter && onImportScene ? (
      <button
        className="btn primary ui-press"
        onClick={() => void handleImportScene()}
        disabled={starting}
      >
        {starting ? '正在导入…' : importedScene ? '已导入场景' : '导入场景'}
      </button>
    ) : null;
  const canFollow = Boolean(follow?.creator && follow.creator.id !== follow.accountId);
  const editLabel =
    view.type === 'scenario' && onEditCharacter ? `编辑${isCharacter ? '角色' : '场景'}` : '编辑';
  const author = view.verifiedCreator ? (
    <button
      type="button"
      className="market-detail-author"
      onClick={() => requestProfileView(view.verifiedCreator!.username)}
    >
      @{view.verifiedCreator.username}
    </button>
  ) : (
    view.author || '未认证作者'
  );

  return (
    <Overlay onDismiss={onClose} className="mkt-scope market-detail-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="market-item-title"
        className="modal market-detail"
      >
        {/* One bar: back (a phone pushes this screen) or close (a dialog on wide screens),
            the title, and one ⋯ menu that holds every secondary action. */}
        <header className="modal-head market-detail-bar">
          <button
            type="button"
            className="icon-btn market-detail-back ui-press"
            aria-label="关闭条目详情"
            onClick={onClose}
          >
            <ChevronLeft className="market-detail-back-icon h-6 w-6" aria-hidden="true" />
            <X className="market-detail-close-icon h-5 w-5" aria-hidden="true" />
          </button>
          <h2 id="market-item-title">{view.name}</h2>
          <div
            ref={moreRef}
            className="market-detail-more"
            onKeyDown={(event) => {
              // Escape closes only the menu; the Overlay would otherwise close the screen.
              if (event.key === 'Escape' && menuOpen) {
                event.stopPropagation();
                setMenuOpen(false);
              }
            }}
          >
            <button
              type="button"
              className="icon-btn ui-press"
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
            </button>
            {menuOpen && (
              <div role="menu" aria-label="更多操作" className="market-detail-menu ui-menu-in">
                {primaryAction && (
                  <button type="button" role="menuitem" onClick={fromMenu(() => void handleCopy())}>
                    复制 JSON
                  </button>
                )}
                <button type="button" role="menuitem" onClick={fromMenu(handleDownload)}>
                  下载 .json
                </button>
                {pulse && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={fromMenu(() => download(`${view.name}.pulse`, pulse))}
                  >
                    下载 .pulse
                  </button>
                )}
                {canFollow && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={followBusy}
                    onClick={fromMenu(() => void handleFollow())}
                  >
                    {follow?.followed ? '取消关注作者' : '关注作者'}
                  </button>
                )}
                {view.type === 'scenario' && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={fromMenu(() => setReporting(true))}
                  >
                    举报
                  </button>
                )}
                {!editing && access.canEdit && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={fromMenu(() =>
                      view.type === 'scenario' && onEditCharacter
                        ? onEditCharacter(view)
                        : startEdit(),
                    )}
                  >
                    {editLabel}
                  </button>
                )}
                {!editing && access.canDelete && (
                  <button
                    type="button"
                    role="menuitem"
                    className="market-detail-menu-danger"
                    disabled={deleting}
                    onClick={fromMenu(() => void handleDelete())}
                  >
                    {deleting ? '删除中…' : '删除'}
                  </button>
                )}
              </div>
            )}
          </div>
        </header>

        <div className="market-detail-identity">
          <span className="market-detail-art" aria-hidden="true">
            {view.type === 'scenario' && (view.content as ScenarioContent).portraitId ? (
              <img
                className="market-detail-portrait"
                src={characterPortraitUrl((view.content as ScenarioContent).portraitId!)}
                alt=""
              />
            ) : view.type === 'waveform' ? (
              '〰️'
            ) : (
              view.icon || '🎭'
            )}
          </span>
          <div className="market-detail-heading">
            <p className="market-detail-name">{view.name}</p>
            <p className="modal-meta">
              {view.type === 'waveform'
                ? (view.content as WaveformContent).modality === 'vibration'
                  ? '震动波形'
                  : '电击波形'
                : isCharacter
                  ? '角色'
                  : '场景'}
              {view.type === 'scenario' && isExtraLargeScenario(view.content as ScenarioContent)
                ? ' · 超大场景'
                : ''}
              {' · '}
              {author}
            </p>
            <p className="modal-meta tabular-nums">
              {view.views} 次浏览 · {view.downloads} 次下载
            </p>
          </div>
        </div>

        <div className="market-detail-actions">
          <div className="market-detail-fav">
            <FavoriteAction key={view.id} itemId={view.id} />
          </div>
          <button
            type="button"
            className="btn market-detail-tip ui-press"
            onClick={() => void handleTip()}
          >
            打赏
          </button>
          <span className="market-detail-tip-hint">每位用户首次下载，作者获得 5 Credit</span>
        </div>

        {view.description?.trim() && <p className="modal-desc">{view.description}</p>}

        {reporting && view.type === 'scenario' && (
          <div className="market-detail-report">
            <CharacterReportAction itemId={view.id} defaultOpen />
          </div>
        )}

        {editing && (
          <div className="admin-edit">
            <p className="admin-edit-title">编辑内容</p>
            <label className="field">
              <span>名称 *</span>
              <input value={eName} onChange={(e) => setEName(e.target.value)} maxLength={60} />
            </label>
            {view.type === 'scenario' && (
              <label className="field">
                <span>
                  剧本内容 * · {ePrompt.length.toLocaleString()} /{' '}
                  {MAX_SCENARIO_PROMPT_LENGTH.toLocaleString()}
                </span>
                <textarea rows={12} value={ePrompt} onChange={(e) => setEPrompt(e.target.value)} />
              </label>
            )}
            {isCharacter && (
              <CharacterCardFields value={eCharacterCard} onChange={setECharacterCard} />
            )}
            <div className="row">
              <label className="field">
                <span>作品署名（可选）</span>
                <input
                  value={eAuthor}
                  onChange={(e) => setEAuthor(e.target.value)}
                  maxLength={30}
                  placeholder="发布账户仍会公开显示"
                />
              </label>
              {hasIcon && (
                <label className="field icon-field">
                  <span>图标</span>
                  <input value={eIcon} onChange={(e) => setEIcon(e.target.value)} maxLength={8} />
                </label>
              )}
            </div>
            <label className="field">
              <span>简介</span>
              <input value={eDesc} onChange={(e) => setEDesc(e.target.value)} maxLength={500} />
            </label>
            <label className="field">
              <span>标签（逗号分隔）</span>
              <input
                value={eTags}
                onChange={(e) => setETags(e.target.value)}
                placeholder="温柔, 节奏感"
              />
            </label>
            {editErr && (
              <p role="alert" className="error">
                {editErr}
              </p>
            )}
            <div className="modal-actions">
              <button className="btn primary" onClick={saveEdit} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
              <button className="btn" onClick={() => setEditing(false)} disabled={saving}>
                取消
              </button>
            </div>
          </div>
        )}

        {view.type === 'waveform' ? (
          <WaveformPreview frames={(view.content as WaveformContent).frames} height={96} />
        ) : (
          <div className="scene-detail">
            {publicCard && (
              <div className="role-cards">
                {(
                  [
                    ['人物背景', publicCard.description],
                    ['性格', publicCard.personality],
                    ['开场白', publicCard.greeting],
                    ['对话示例', publicCard.exampleDialogue],
                    ['原作者', publicCard.creator],
                    ['使用许可', publicCard.license],
                  ] as const
                )
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div key={label} className="role-card">
                      <strong>{label}</strong>
                      <p className="whitespace-pre-wrap">{value}</p>
                    </div>
                  ))}
              </div>
            )}
            <pre className="prompt-box">{(view.content as ScenarioContent).prompt}</pre>
          </div>
        )}

        {[copyError, actionError, startError].filter(Boolean).map((message) => (
          <p key={message} role="alert" className="error">
            {message}
          </p>
        ))}
        {/* The menu closes on copy, so its success needs its own line. */}
        {copied && primaryAction && (
          <p role="status" className="modal-hint">
            已复制 JSON
          </p>
        )}

        <p className="modal-hint">
          {view.type === 'scenario'
            ? isCharacter
              ? '聊天中的称呼、关系和记忆只属于你，作者更新卡片也不会改动。'
              : importedScene
                ? '已导入。在角色聊天里点名字 → 场景 即可选用。'
                : '场景只是聊天发生的环境，不是角色，也没有记忆。'
            : '在设备页的「波形」里点「从市场导入」即可使用。'}
        </p>

        {/* The one primary action. A phone pins it full width at the bottom. */}
        <div className="market-detail-primary">
          {primaryAction ?? (
            <button className="btn primary ui-press" onClick={handleCopy}>
              {copied ? '已复制 ✓' : '复制 JSON'}
            </button>
          )}
        </div>
      </div>
    </Overlay>
  );
}
