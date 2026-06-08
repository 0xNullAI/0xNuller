import { useRef, useState } from 'react';
import { unzipSync, strFromU8 } from 'fflate';
import type { ItemType, UploadPayload } from '../../shared/schema';
import { parsePulseText } from '../../shared/pulse';
import { uploadItem } from '../api';
import { Turnstile } from './Turnstile';
import { WaveformPreview } from './WaveformPreview';

type Frame = [number, number];

// 从上传的文件里取出 .pulse 文本：.pulse 直接读，.zip 取第一个 .pulse 条目。
async function readPulseFromFile(file: File): Promise<{ text: string; embeddedName: string }> {
  if (/\.zip$/i.test(file.name)) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const entries = unzipSync(buf);
    const pulseName = Object.keys(entries).find((n) => /\.pulse$/i.test(n) && !n.startsWith('__'));
    if (!pulseName) throw new Error('压缩包里没有找到 .pulse 文件');
    const text = strFromU8(entries[pulseName]!);
    return { text, embeddedName: pulseName.replace(/.*\//, '').replace(/\.pulse$/i, '') };
  }
  const text = await file.text();
  return { text, embeddedName: file.name.replace(/\.pulse$/i, '') };
}

interface Props {
  siteKey: string;
  onClose: () => void;
  onUploaded: () => void;
}

// 从用户输入解析出波形 frames：支持 .pulse 文本，或直接粘贴 frames JSON 数组。
function parseWaveInput(text: string): { frames: Frame[]; pulse?: string } {
  const trimmed = text.trim();
  if (/^Dungeonlab\+pulse:/i.test(trimmed)) {
    const { frames } = parsePulseText(trimmed);
    return { frames: frames as Frame[], pulse: trimmed };
  }
  // 尝试当作 JSON：可能是 {frames:[...]} 或裸 [[f,s],...]
  const data = JSON.parse(trimmed) as unknown;
  const frames = Array.isArray(data) ? data : (data as { frames?: unknown }).frames;
  if (!Array.isArray(frames)) throw new Error('JSON 中找不到 frames 数组');
  return { frames: frames as Frame[] };
}

export function UploadDialog({ siteKey, onClose, onUploaded }: Props): JSX.Element {
  const [type, setType] = useState<ItemType>('waveform');
  const [name, setName] = useState('');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('🎭');
  const [tagsText, setTagsText] = useState('');
  const [waveInput, setWaveInput] = useState('');
  const [prompt, setPrompt] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Frame[] | null>(null);
  // —— 多人场景字段 ——
  const [setting, setSetting] = useState('');
  const [playerMin, setPlayerMin] = useState('2');
  const [playerMax, setPlayerMax] = useState('4');
  const [aiMode, setAiMode] = useState<'none' | 'solo' | 'multi'>('none');
  const [roles, setRoles] = useState<{ name: string; description: string; aiPlayable: boolean; aiPersona: string }[]>([
    { name: '', description: '', aiPlayable: false, aiPersona: '' },
  ]);
  const fileRef = useRef<HTMLInputElement>(null);

  const updateRole = (
    i: number,
    patch: Partial<{ name: string; description: string; aiPlayable: boolean; aiPersona: string }>,
  ) => setRoles((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRole = () => setRoles((rs) => [...rs, { name: '', description: '', aiPlayable: false, aiPersona: '' }]);
  const removeRole = (i: number) => setRoles((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));

  const handleFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError('');
    try {
      const { text, embeddedName } = await readPulseFromFile(file);
      const { name: pulseName } = parsePulseText(text); // 校验并取内嵌名
      tryPreview(text);
      // 名称为空时用波形内嵌名 / 文件名自动填充
      if (!name.trim()) setName(pulseName || embeddedName);
    } catch (e) {
      setPreview(null);
      setError(`文件解析失败：${(e as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const tryPreview = (text: string) => {
    setWaveInput(text);
    setError('');
    if (!text.trim()) {
      setPreview(null);
      return;
    }
    try {
      setPreview(parseWaveInput(text).frames);
    } catch (e) {
      setPreview(null);
      setError(`波形解析失败：${(e as Error).message}`);
    }
  };

  const submit = async () => {
    setError('');
    if (!name.trim()) return setError('请填写名称');
    if (!token) return setError('请先完成人机验证');

    const tags = tagsText
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 6);

    let payload: UploadPayload;
    try {
      if (type === 'waveform') {
        const { frames, pulse } = parseWaveInput(waveInput);
        payload = {
          type: 'waveform',
          name: name.trim(),
          description: description.trim() || undefined,
          author: author.trim() || undefined,
          tags,
          content: { frames, pulse },
          turnstileToken: token,
        };
      } else if (type === 'scenario') {
        if (!prompt.trim()) return setError('请填写场景提示词');
        // 单人场景始终带「DG Agent」标签（去重、限 6 个）。
        const scenarioTags = tags.includes('DG Agent') ? tags : ['DG Agent', ...tags].slice(0, 6);
        payload = {
          type: 'scenario',
          name: name.trim(),
          description: description.trim() || undefined,
          author: author.trim() || undefined,
          icon: icon.trim() || undefined,
          tags: scenarioTags,
          content: { prompt: prompt.trim() },
          turnstileToken: token,
        };
      } else {
        if (!setting.trim()) return setError('请填写世界观');
        const cleanRoles = roles
          .filter((r) => r.name.trim())
          .map((r) => ({
            name: r.name.trim(),
            description: r.description.trim() || undefined,
            aiPlayable: r.aiPlayable || undefined,
            aiPersona: (r.aiPlayable && r.aiPersona.trim()) || undefined,
          }));
        if (cleanRoles.length === 0) return setError('至少填写一个角色');
        const mn = Math.max(1, Number(playerMin) || 1);
        const mx = Math.max(mn, Number(playerMax) || mn);
        payload = {
          type: 'multi-scene',
          name: name.trim(),
          description: description.trim() || undefined,
          author: author.trim() || undefined,
          icon: icon.trim() || undefined,
          tags,
          content: { setting: setting.trim(), roles: cleanRoles, playerCount: { min: mn, max: mx }, aiMode },
          turnstileToken: token,
        };
      }
    } catch (e) {
      return setError((e as Error).message);
    }

    setBusy(true);
    try {
      await uploadItem(payload);
      onUploaded();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>上传到市场</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="tab-group">
          <div className="seg">
            <button
              className={type === 'scenario' || type === 'multi-scene' ? 'active' : ''}
              onClick={() => setType((t) => (t === 'waveform' ? 'scenario' : t))}
            >
              场景
            </button>
            <button className={type === 'waveform' ? 'active' : ''} onClick={() => setType('waveform')}>
              波形
            </button>
          </div>
          {(type === 'scenario' || type === 'multi-scene') && (
            <div className="seg seg-sub">
              <button className={type === 'scenario' ? 'active' : ''} onClick={() => setType('scenario')}>
                单人
              </button>
              <button className={type === 'multi-scene' ? 'active' : ''} onClick={() => setType('multi-scene')}>
                多人
              </button>
            </div>
          )}
        </div>
        {type === 'scenario' && (
          <p className="upload-note">单人场景将自动标记 DG Agent，供 DG-Agent 导入。</p>
        )}

        <label className="field">
          <span>名称 *</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>

        <div className="row">
          <label className="field">
            <span>昵称（可选）</span>
            <input value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={30} placeholder="匿名" />
          </label>
          {(type === 'scenario' || type === 'multi-scene') && (
            <label className="field icon-field">
              <span>图标</span>
              <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={8} />
            </label>
          )}
        </div>

        <label className="field">
          <span>简介（可选）</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </label>

        <label className="field">
          <span>标签（逗号分隔，可选）</span>
          <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="温柔, 节奏感" />
        </label>

        {type === 'waveform' ? (
          <>
            <label className="field">
              <span>波形数据 *</span>
              <label className="file-drop">
                <span>📁 选择 .pulse / .zip 文件</span>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pulse,.zip"
                  className="file-input-hidden"
                  onChange={(e) => void handleFile(e.target.files)}
                />
              </label>
              <textarea
                rows={4}
                value={waveInput}
                onChange={(e) => tryPreview(e.target.value)}
                placeholder="或在此粘贴 Dungeonlab+pulse:... 文本 / frames JSON"
              />
            </label>
            {preview && (
              <div className="preview-wrap">
                <WaveformPreview frames={preview} />
                <small>{preview.length} 帧 · {(preview.length * 25) / 1000}s</small>
              </div>
            )}
          </>
        ) : type === 'scenario' ? (
          <label className="field">
            <span>场景提示词 *</span>
            <textarea
              rows={8}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={12000}
              placeholder="粘贴你的自定义场景设定…"
            />
          </label>
        ) : (
          <>
            <label className="field">
              <span>世界观 / 背景 *</span>
              <textarea
                rows={5}
                value={setting}
                onChange={(e) => setSetting(e.target.value)}
                maxLength={8000}
                placeholder="描述这个多人场景的世界观、氛围、规则…"
              />
            </label>
            <p className="upload-note">推荐人数会显著影响匹配，建议认真填写。</p>
            <div className="row">
              <label className="field">
                <span>推荐人数（最少）★</span>
                <input type="number" min={1} max={50} value={playerMin} onChange={(e) => setPlayerMin(e.target.value)} />
              </label>
              <label className="field">
                <span>推荐人数（最多）★</span>
                <input type="number" min={1} max={50} value={playerMax} onChange={(e) => setPlayerMax(e.target.value)} />
              </label>
              <label className="field">
                <span>AI 参与</span>
                <select value={aiMode} onChange={(e) => setAiMode(e.target.value as 'none' | 'solo' | 'multi')}>
                  <option value="none">纯人（无 AI）</option>
                  <option value="solo">单个 AI</option>
                  <option value="multi">多个 AI</option>
                </select>
              </label>
            </div>
            <div className="field">
              <span>角色 * — 每人扮演一个</span>
              <div className="role-list">
                {roles.map((r, i) => (
                  <div key={i} className="role-item">
                    <div className="role-row">
                      <input
                        className="role-name"
                        value={r.name}
                        onChange={(e) => updateRole(i, { name: e.target.value })}
                        maxLength={40}
                        placeholder={`角色 ${i + 1}`}
                      />
                      <input
                        className="role-desc"
                        value={r.description}
                        onChange={(e) => updateRole(i, { description: e.target.value })}
                        maxLength={300}
                        placeholder="角色描述（可选）"
                      />
                      <label className="role-ai" title="该角色可由 AI 扮演">
                        <input type="checkbox" checked={r.aiPlayable} onChange={(e) => updateRole(i, { aiPlayable: e.target.checked })} />
                        AI
                      </label>
                      <button type="button" className="icon-btn" onClick={() => removeRole(i)} disabled={roles.length <= 1}>
                        ✕
                      </button>
                    </div>
                    {r.aiPlayable && (
                      <textarea
                        className="role-persona"
                        rows={3}
                        value={r.aiPersona}
                        onChange={(e) => updateRole(i, { aiPersona: e.target.value })}
                        maxLength={2000}
                        placeholder="AI 人设（给 AI 的详细身份/口吻/动机，可选）"
                      />
                    )}
                  </div>
                ))}
              </div>
              <button type="button" className="btn add-role" onClick={addRole}>
                + 加角色
              </button>
            </div>
          </>
        )}

        {error && <p className="error">{error}</p>}

        <Turnstile siteKey={siteKey} onToken={setToken} />

        <div className="modal-actions">
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? '上传中…' : '上传'}
          </button>
          <button className="btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
