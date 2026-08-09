import type { JSX } from 'react';
import { useState } from 'react';
import { Overlay } from '@0xnullai/ui';
import type {
  ItemPatch,
  MarketItem,
  ScenarioContent,
  WaveformContent,
  MultiSceneContent,
} from '../../shared/schema';
import { updateItem, markDownloaded, reportItem } from '../api';
import { WaveformPreview } from './WaveformPreview';

interface Props {
  item: MarketItem;
  onClose: () => void;
  onUpdated?: (item: MarketItem) => void;
}

// Remember the edit key already used for each item so repeated edits don't need it retyped.
const EDIT_KEY_STORE = 'dg-market-edit-key';

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ItemDetail({ item, onClose, onUpdated }: Props): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [reported, setReported] = useState(false);
  // Snapshot of the metadata currently on screen (an admin edit can overwrite it).
  const [view, setView] = useState<MarketItem>(item);

  // —— edit state ——
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState(
    () => localStorage.getItem(`${EDIT_KEY_STORE}:${item.id}`) ?? '',
  );
  const [eName, setEName] = useState(item.name);
  const [eAuthor, setEAuthor] = useState(item.author ?? '');
  const [eDesc, setEDesc] = useState(item.description ?? '');
  const [eIcon, setEIcon] = useState(item.icon ?? '');
  const [eTags, setETags] = useState(item.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState('');

  const hasIcon = view.type !== 'waveform';

  // The JSON shape Agent can import directly.
  const exportJson = JSON.stringify(
    view.type === 'waveform'
      ? {
          name: view.name,
          description: view.description,
          frames: (item.content as WaveformContent).frames,
        }
      : view.type === 'multi-scene'
        ? { name: view.name, icon: view.icon, ...(item.content as MultiSceneContent) }
        : { name: view.name, icon: view.icon, prompt: (item.content as ScenarioContent).prompt },
    null,
    2,
  );

  const handleCopy = async () => {
    await navigator.clipboard.writeText(exportJson);
    setCopied(true);
    void markDownloaded(item.id);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleDownload = () => {
    const safe = view.name.replace(/[^\w一-龥-]+/g, '_');
    download(`${safe}.json`, exportJson);
    void markDownloaded(item.id);
  };

  const handleReport = async () => {
    await reportItem(item.id);
    setReported(true);
  };

  const startEdit = () => {
    setEName(view.name);
    setEAuthor(view.author ?? '');
    setEDesc(view.description ?? '');
    setEIcon(view.icon ?? '');
    setETags(view.tags.join(', '));
    setEditErr('');
    setEditing(true);
  };

  const saveEdit = async () => {
    setEditErr('');
    if (!eName.trim()) return setEditErr('名称不能为空');
    if (view.locked && !editKey.trim()) return setEditErr('此条目已设编辑口令，请输入口令');

    const tags = eTags
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);
    const patch: ItemPatch = {
      name: eName.trim(),
      author: eAuthor.trim(),
      description: eDesc.trim(),
      tags,
      ...(hasIcon ? { icon: eIcon.trim() } : {}),
    };

    setSaving(true);
    try {
      await updateItem(item.id, patch, editKey.trim() || undefined);
      if (editKey.trim()) localStorage.setItem(`${EDIT_KEY_STORE}:${item.id}`, editKey.trim());
      const updated: MarketItem = {
        ...view,
        name: patch.name!,
        author: patch.author || undefined,
        description: patch.description || undefined,
        icon: hasIcon ? eIcon.trim() || undefined : view.icon,
        tags,
      };
      setView(updated);
      onUpdated?.(updated);
      setEditing(false);
    } catch (e) {
      setEditErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const pulse = view.type === 'waveform' ? (item.content as WaveformContent).pulse : undefined;

  return (
    <Overlay onDismiss={onClose} className="mkt-scope">
      <div role="dialog" aria-modal="true" aria-labelledby="market-item-title" className="modal">
        <header className="modal-head">
          <h2 id="market-item-title">
            {view.type === 'waveform'
              ? '〰️ '
              : `${view.icon || (view.type === 'multi-scene' ? '🎬' : '🎭')} `}
            {view.name}
          </h2>
          <button type="button" className="icon-btn" aria-label="关闭条目详情" onClick={onClose}>
            ✕
          </button>
        </header>

        <p className="modal-meta">
          {view.type === 'waveform'
            ? '波形'
            : view.type === 'multi-scene'
              ? '多人场景'
              : '单人场景'}{' '}
          · {view.author ? `@${view.author}` : '匿名'} · 👁 {view.views} · ↓ {view.downloads}
          {view.type === 'scenario' && <span className="agent-badge">DG Agent</span>}
        </p>

        {view.description && <p className="modal-desc">{view.description}</p>}

        {editing && (
          <div className="admin-edit">
            <p className="admin-edit-title">✏️ 编辑（仅元数据）</p>
            <label className="field">
              <span>名称 *</span>
              <input value={eName} onChange={(e) => setEName(e.target.value)} maxLength={60} />
            </label>
            <div className="row">
              <label className="field">
                <span>昵称</span>
                <input
                  value={eAuthor}
                  onChange={(e) => setEAuthor(e.target.value)}
                  maxLength={30}
                  placeholder="匿名"
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
            {view.locked ? (
              <label className="field">
                <span>编辑口令</span>
                <input
                  type="password"
                  value={editKey}
                  onChange={(e) => setEditKey(e.target.value)}
                  placeholder="上传时设置的口令"
                />
              </label>
            ) : (
              <p className="modal-hint">此条目未设口令，任何人都可编辑。</p>
            )}
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
          <WaveformPreview frames={(item.content as WaveformContent).frames} height={96} />
        ) : view.type === 'multi-scene' ? (
          (() => {
            const c = item.content as MultiSceneContent;
            const aiLabel =
              c.aiMode === 'solo' ? '单个 AI' : c.aiMode === 'multi' ? '多个 AI' : '纯人';
            return (
              <div className="scene-detail">
                <pre className="prompt-box">{c.setting}</pre>
                <div className="scene-meta">
                  {c.playerCount && (
                    <span>
                      👥 建议 {c.playerCount.min}-{c.playerCount.max} 人
                    </span>
                  )}
                  <span>🤖 {aiLabel}</span>
                </div>
                <div className="role-cards">
                  {c.roles.map((r, i) => (
                    <div key={i} className="role-card">
                      <strong>
                        {r.name}
                        {r.aiPlayable && <span className="ai-tag">AI 可</span>}
                      </strong>
                      {r.description && <p>{r.description}</p>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()
        ) : (
          <pre className="prompt-box">{(item.content as ScenarioContent).prompt}</pre>
        )}

        <div className="modal-actions">
          <button className="btn primary" onClick={handleCopy}>
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
          <button className="btn ghost" onClick={handleReport} disabled={reported}>
            {reported ? '已举报' : '举报'}
          </button>
          {!editing && (
            <button
              className="btn ghost"
              onClick={startEdit}
              title={view.locked ? '需要编辑口令' : '任何人可编辑'}
            >
              {view.locked ? '🔒 编辑' : '✏️ 编辑'}
            </button>
          )}
        </div>

        <p className="modal-hint">
          {view.type === 'multi-scene'
            ? '在 Chat 房间『场景 → 从市场导入』即可使用。'
            : view.type === 'scenario'
              ? '在 Agent 点『从市场导入』即可使用；或复制 JSON 手动导入。'
              : '在 Agent 的「波形库」面板点「从市场导入」即可直接使用；或复制 JSON 手动导入。'}
        </p>
      </div>
    </Overlay>
  );
}
