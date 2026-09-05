import { scriptLengthError } from '../script-length';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Overlay } from '@0xnullai/ui';
import type {
  ItemPatch,
  MarketItem,
  ScenarioContent,
  WaveformContent,
  MultiSceneContent,
} from '../../shared/schema';
import { isExtraLargeScenario } from '../../shared/schema';
import { MAX_SCENARIO_PROMPT_LENGTH } from '../../shared/schema';
import { deleteItem, fetchItemAccess, updateItem, markDownloaded } from '../api';
import { WaveformPreview } from './WaveformPreview';

interface Props {
  item: MarketItem;
  onClose: () => void;
  onUpdated?: (item: MarketItem) => void;
  onDeleted?: (id: string) => void;
}

interface EditableRole {
  name: string;
  description: string;
  aiPlayable: boolean;
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

export function ItemDetail({ item, onClose, onUpdated, onDeleted }: Props): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  // Snapshot of the metadata currently on screen.
  const [view, setView] = useState<MarketItem>(item);
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
  const initialMulti = item.type === 'multi-scene' ? (item.content as MultiSceneContent) : null;
  const [eSetting, setESetting] = useState(initialMulti?.setting ?? '');
  const [ePlayerMin, setEPlayerMin] = useState(String(initialMulti?.playerCount?.min ?? 2));
  const [ePlayerMax, setEPlayerMax] = useState(String(initialMulti?.playerCount?.max ?? 4));
  const [eAiMode, setEAiMode] = useState<NonNullable<MultiSceneContent['aiMode']>>(
    initialMulti?.aiMode ?? 'none',
  );
  const [eRoles, setERoles] = useState<EditableRole[]>(
    initialMulti?.roles.map((role) => ({
      name: role.name,
      description: role.description ?? '',
      aiPlayable: role.aiPlayable ?? false,
    })) ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState('');
  const [deleting, setDeleting] = useState(false);

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
      : view.type === 'multi-scene'
        ? { name: view.name, icon: view.icon, ...(view.content as MultiSceneContent) }
        : { name: view.name, icon: view.icon, prompt: (view.content as ScenarioContent).prompt },
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

  const startEdit = () => {
    setEName(view.name);
    setEAuthor(view.author ?? '');
    setEDesc(view.description ?? '');
    setEIcon(view.icon ?? '');
    setETags(view.tags.join(', '));
    if (view.type === 'scenario') setEPrompt((view.content as ScenarioContent).prompt);
    if (view.type === 'multi-scene') {
      const content = view.content as MultiSceneContent;
      setESetting(content.setting);
      setEPlayerMin(String(content.playerCount?.min ?? 2));
      setEPlayerMax(String(content.playerCount?.max ?? 4));
      setEAiMode(content.aiMode ?? 'none');
      setERoles(
        content.roles.map((role) => ({
          name: role.name,
          description: role.description ?? '',
          aiPlayable: role.aiPlayable ?? false,
        })),
      );
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
      setting: eSetting,
      roles: eRoles,
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
      content = { prompt: ePrompt };
    } else if (view.type === 'multi-scene') {
      if (!eSetting.trim()) return setEditErr('世界观 / 背景不能为空');
      const min = Number(ePlayerMin);
      const max = Number(ePlayerMax);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 50 || min > max) {
        return setEditErr('推荐人数需为 1–50，且最少人数不能超过最多人数');
      }
      const roles = eRoles
        .map((role) => ({
          name: role.name.trim(),
          ...(role.description.trim() ? { description: role.description.trim() } : {}),
          ...(role.aiPlayable ? { aiPlayable: true } : {}),
        }))
        .filter((role) => role.name);
      if (roles.length === 0) return setEditErr('至少需要一个角色');
      content = {
        setting: eSetting.trim(),
        playerCount: { min, max },
        aiMode: eAiMode,
        roles,
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
      setView(updated);
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

  const updateRole = (index: number, patch: Partial<EditableRole>) =>
    setERoles((roles) => roles.map((role, i) => (i === index ? { ...role, ...patch } : role)));

  const pulse = view.type === 'waveform' ? (view.content as WaveformContent).pulse : undefined;

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
            {view.type === 'multi-scene' && (
              <>
                <label className="field">
                  <span>世界观 / 背景 *</span>
                  <textarea
                    rows={7}
                    value={eSetting}
                    onChange={(e) => setESetting(e.target.value)}
                  />
                </label>
                <div className="row">
                  <label className="field">
                    <span>推荐人数（最少）</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={ePlayerMin}
                      onChange={(e) => setEPlayerMin(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>推荐人数（最多）</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={ePlayerMax}
                      onChange={(e) => setEPlayerMax(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>AI 参与</span>
                    <select
                      value={eAiMode}
                      onChange={(e) =>
                        setEAiMode(e.target.value as NonNullable<MultiSceneContent['aiMode']>)
                      }
                    >
                      <option value="none">纯人（无 AI）</option>
                      <option value="solo">单个 AI</option>
                      <option value="multi">多个 AI</option>
                    </select>
                  </label>
                </div>
                <div className="field">
                  <span>角色 * — 每人扮演一个</span>
                  <div className="role-list">
                    {eRoles.map((role, index) => (
                      <div key={index} className="role-item">
                        <div className="role-row">
                          <input
                            className="role-name"
                            value={role.name}
                            onChange={(e) => updateRole(index, { name: e.target.value })}
                            maxLength={40}
                            placeholder={`角色 ${index + 1}`}
                          />
                          <input
                            className="role-desc"
                            value={role.description}
                            onChange={(e) => updateRole(index, { description: e.target.value })}
                            placeholder="角色描述 / AI 人设"
                          />
                          <label className="role-ai">
                            <input
                              type="checkbox"
                              checked={role.aiPlayable}
                              onChange={(e) => updateRole(index, { aiPlayable: e.target.checked })}
                            />
                            AI
                          </label>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`删除角色 ${index + 1}`}
                            onClick={() =>
                              setERoles((roles) => roles.filter((_, i) => i !== index))
                            }
                            disabled={eRoles.length <= 1}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn add-role"
                    onClick={() =>
                      setERoles((roles) => [
                        ...roles,
                        { name: '', description: '', aiPlayable: false },
                      ])
                    }
                    disabled={eRoles.length >= 12}
                  >
                    + 加角色
                  </button>
                </div>
              </>
            )}
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
        ) : view.type === 'multi-scene' ? (
          (() => {
            const c = view.content as MultiSceneContent;
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
          <pre className="prompt-box">{(view.content as ScenarioContent).prompt}</pre>
        )}

        {copyError && (
          <p role="alert" className="error">
            {copyError}
          </p>
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
          {!editing && access.canEdit && (
            <button className="btn ghost" onClick={startEdit} title="编辑自己的内容">
              ✏️ 编辑
            </button>
          )}
          {!editing && access.canDelete && (
            <button className="btn ghost" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? '删除中…' : '删除'}
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
