import { CharacterReportAction } from './CharacterReports';
import { CreatorFollowAction } from './CreatorFollowAction';
import { FavoriteAction } from './FavoriteAction';
import { parseCharacterCard, type CharacterCard } from '@0xnullai/scenes/character-card';
import { CharacterCardFields } from '@0xnullai/scenes/character-editor';
import { scriptLengthError } from '../script-length';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Overlay } from '@0xnullai/ui';
import type { ItemPatch, MarketItem, ScenarioContent, WaveformContent } from '../../shared/schema';
import { isExtraLargeScenario, promptKind } from '../../shared/schema';
import { MAX_SCENARIO_PROMPT_LENGTH } from '../../shared/schema';
import {
  characterPortraitUrl,
  deleteItem,
  fetchItemAccess,
  updateItem,
  markDownloaded,
  tipItem,
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

  useEffect(() => {
    let active = true;
    fetchItemAccess(item.id)
      .then((next) => active && setAccess(next))
      .catch(() => active && setAccess({ canEdit: false, canDelete: false }));
    return () => {
      active = false;
    };
  }, [item.id]);

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
    setEditErr('');
    try {
      await deleteItem(item.id);
      onDeleted?.(item.id);
      onClose();
    } catch (error) {
      setEditErr(error instanceof Error ? error.message : '删除失败');
      setDeleting(false);
    }
  };

  const pulse = view.type === 'waveform' ? (view.content as WaveformContent).pulse : undefined;

  return (
    <Overlay onDismiss={onClose} className="mkt-scope">
      <div role="dialog" aria-modal="true" aria-labelledby="market-item-title" className="modal">
        <header className="modal-head">
          {view.type === 'scenario' && (view.content as ScenarioContent).portraitId && (
            <img
              className="market-detail-portrait"
              src={characterPortraitUrl((view.content as ScenarioContent).portraitId!)}
              alt=""
            />
          )}
          <h2 id="market-item-title">
            {view.type === 'waveform' ? '〰️ ' : `${view.icon || '🎭'} `}
            {view.name}
          </h2>
          <button type="button" className="icon-btn" aria-label="关闭条目详情" onClick={onClose}>
            ✕
          </button>
        </header>

        <p className="modal-meta">
          {view.type === 'waveform' ? '波形' : isCharacter ? '角色' : '场景'} ·{' '}
          {view.verifiedCreator
            ? `✓ @${view.verifiedCreator.username}`
            : view.author
              ? `署名：${view.author}`
              : '未认证作者'}{' '}
          · 👁 {view.views} · ↓ {view.downloads}
          {view.type === 'scenario' && (
            <span className="agent-badge">{isCharacter ? '角色' : '场景'}</span>
          )}
          {view.type === 'scenario' && isExtraLargeScenario(view.content as ScenarioContent) && (
            <span className="scale-badge">超大场景</span>
          )}
          {view.type === 'waveform' && (
            <span className="agent-badge">
              {(view.content as WaveformContent).modality === 'vibration' ? '震动' : '电击'}
            </span>
          )}
        </p>

        {view.description && <p className="modal-desc">{view.description}</p>}
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn" onClick={() => void handleTip()}>
            给作者打赏
          </button>
          <span className="text-xs text-[var(--text-faint)]">
            每位用户首次下载，作者获得 5 Credit
          </span>
        </div>

        {editing && (
          <div className="admin-edit">
            <p className="admin-edit-title">✏️ 编辑内容</p>
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

        {copyError && (
          <p role="alert" className="error">
            {copyError}
          </p>
        )}
        <CreatorFollowAction key={`creator:${view.id}`} itemId={view.id} />
        <FavoriteAction key={view.id} itemId={view.id} />
        {view.type === 'scenario' && <CharacterReportAction itemId={view.id} />}
        <div className="modal-actions">
          {isCharacter && onStartCharacter && (
            <button
              className="btn primary"
              onClick={() => void handleStartCharacter()}
              disabled={starting}
            >
              {starting ? '正在打开聊天…' : '开始聊天'}
            </button>
          )}
          {view.type === 'scenario' && !isCharacter && onImportScene && (
            <button
              className="btn primary"
              onClick={() => void handleImportScene()}
              disabled={starting}
            >
              {starting ? '正在导入…' : importedScene ? '已导入场景' : '导入场景'}
            </button>
          )}
          <button
            className={
              (isCharacter && onStartCharacter) ||
              (view.type === 'scenario' && !isCharacter && onImportScene)
                ? 'btn'
                : 'btn primary'
            }
            onClick={handleCopy}
          >
            {copied ? '已复制 ✓' : '复制 JSON'}
          </button>
          <button className="btn" onClick={handleDownload}>
            下载 .json
          </button>
          {pulse && (
            <button className="btn" onClick={() => download(`${view.name}.pulse`, pulse)}>
              下载 .pulse
            </button>
          )}
          {!editing && access.canEdit && (
            <button
              className="btn ghost"
              onClick={() =>
                view.type === 'scenario' && onEditCharacter ? onEditCharacter(view) : startEdit()
              }
              title="编辑自己的内容"
            >
              {view.type === 'scenario' && onEditCharacter
                ? `✏️ 编辑${isCharacter ? '角色' : '场景'}`
                : '✏️ 编辑'}
            </button>
          )}
          {!editing && access.canDelete && (
            <button className="btn ghost" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? '删除中…' : '删除'}
            </button>
          )}
        </div>

        {startError && (
          <p role="alert" className="error">
            {startError}
          </p>
        )}

        <p className="modal-hint">
          {view.type === 'scenario'
            ? isCharacter
              ? '开始聊天会在当前账号建立专属角色；公开卡更新不会覆盖你的名字、关系和记忆。'
              : '场景只提供环境与规则，可应用到聊天；不拥有独立关系或记忆。'
            : '在 Agent 的「波形库」面板点「从市场导入」即可直接使用；或复制 JSON 手动导入。'}
        </p>
      </div>
    </Overlay>
  );
}
