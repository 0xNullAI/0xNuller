import { useRef, useState } from 'react';
import { unzipSync, strFromU8 } from 'fflate';
import type { BatchUploadPayload, ItemType, UploadPayload } from '../../shared/schema';
import { parsePulseText } from '../../shared/pulse';
import { batchUploadItems, uploadItem } from '../api';
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

export function UploadDialog({ onClose, onUploaded }: Props): JSX.Element {
  const [type, setType] = useState<ItemType>('waveform');
  const [name, setName] = useState('');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('🎭');
  const [tagsText, setTagsText] = useState('');
  const [waveInput, setWaveInput] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [batchMsg, setBatchMsg] = useState('');
  const [preview, setPreview] = useState<Frame[] | null>(null);
  // —— 多人场景字段 ——
  const [setting, setSetting] = useState('');
  const [playerMin, setPlayerMin] = useState('2');
  const [playerMax, setPlayerMax] = useState('4');
  const [aiMode, setAiMode] = useState<'none' | 'solo' | 'multi'>('none');
  const [roles, setRoles] = useState<{ name: string; description: string; aiPlayable: boolean }[]>([
    { name: '', description: '', aiPlayable: false },
  ]);
  const fileRef = useRef<HTMLInputElement>(null);

  const updateRole = (
    i: number,
    patch: Partial<{ name: string; description: string; aiPlayable: boolean }>,
  ) => setRoles((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRole = () => setRoles((rs) => [...rs, { name: '', description: '', aiPlayable: false }]);
  const removeRole = (i: number) => setRoles((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));
  const tplRef = useRef<HTMLInputElement>(null);
  const batchRef = useRef<HTMLInputElement>(null);

  // 触发浏览器下载一段文本。
  const downloadText = (filename: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 当前类型的 JSON 模板：用一份可直接上传的示例内容填好，照着改字段即可。
  // 公共可填字段：name 名称(必填) / author 上传者昵称 / description 简介 / tags 标签。
  const templateFor = (t: ItemType): unknown => {
    if (t === 'waveform')
      return {
        type: 'waveform',
        name: '示例波形 · 渐强脉冲',
        author: '你的昵称（可选，留空则匿名）',
        description: '由弱到强再回落的循环脉冲，适合作为前戏铺垫。',
        tags: ['渐强', '节奏感'],
        // frames：[编码频率(10..240), 强度(0..100)]，一帧约 25ms。也可改填 pulse 文本。
        content: {
          frames: [[10, 20], [15, 40], [20, 60], [25, 80], [20, 60], [15, 40]],
          pulse: '',
        },
      };
    if (t === 'scenario')
      return {
        type: 'scenario',
        name: '示例场景 · 雨夜便利店',
        author: '你的昵称（可选，留空则匿名）',
        description: '深夜值班的便利店店员，与一位常客之间的暧昧拉扯。',
        icon: '🎭',
        tags: ['DG Agent', '日常', '都市'],
        content: {
          prompt:
            '你是一家深夜便利店的店员，店里只剩你和一位每晚都来的熟客。外面下着大雨，气氛安静而暧昧。请以第一人称展开这段相遇…',
        },
      };
    return {
      type: 'multi-scene',
      name: '示例多人场景 · 末日避难所',
      author: '你的昵称（可选，留空则匿名）',
      description: '资源枯竭的地下避难所里，幸存者们为生存与权力博弈。',
      icon: '🎬',
      tags: ['末日', '生存', '权谋'],
      content: {
        setting:
          '一座末日后的地下避难所，物资濒临耗尽，外面是被污染的废土。幸存者必须在猜疑与合作之间做出选择。',
        playerCount: { min: 2, max: 4 },
        aiMode: 'none', // none 纯人 / solo 单个 AI / multi 多个 AI
        roles: [
          { name: '避难所主管', description: '掌握物资分配权的冷静领袖，信奉秩序高于一切。', aiPlayable: false },
          { name: '流浪医生', description: '唯一懂医术的外来者，立场暧昧、动机成谜。', aiPlayable: true },
        ],
      },
    };
  };

  const downloadTemplate = () => {
    const fn = type === 'waveform' ? '波形模板.json' : type === 'scenario' ? '单人场景模板.json' : '多人场景模板.json';
    downloadText(fn, JSON.stringify(templateFor(type), null, 2));
  };

  // 把一份模板对象回填到表单，返回解析出的类型。
  const applyTemplate = (j: Record<string, unknown>): ItemType => {
    const c = (j.content ?? {}) as Record<string, unknown>;
    const t = (j.type as ItemType) ?? type;
    setType(t);
    if (typeof j.name === 'string') setName(j.name);
    if (typeof j.author === 'string') setAuthor(j.author);
    if (typeof j.icon === 'string') setIcon(j.icon);
    if (typeof j.description === 'string') setDescription(j.description);
    if (Array.isArray(j.tags)) setTagsText((j.tags as string[]).join(', '));
    if (t === 'waveform') {
      setWaveInput(typeof c.pulse === 'string' && c.pulse ? c.pulse : JSON.stringify(c.frames ?? []));
    } else if (t === 'scenario') {
      if (typeof c.prompt === 'string') setPrompt(c.prompt);
    } else {
      if (typeof c.setting === 'string') setSetting(c.setting);
      const pc = (c.playerCount ?? {}) as { min?: number; max?: number };
      if (pc.min != null) setPlayerMin(String(pc.min));
      if (pc.max != null) setPlayerMax(String(pc.max));
      if (c.aiMode === 'none' || c.aiMode === 'solo' || c.aiMode === 'multi') setAiMode(c.aiMode);
      if (Array.isArray(c.roles))
        setRoles(
          (c.roles as Record<string, unknown>[]).map((r) => ({
            name: String(r.name ?? ''),
            description: String(r.description ?? ''),
            aiPlayable: !!r.aiPlayable,
          })),
        );
    }
    return t;
  };

  // 导入填好的模板，回填整个表单（仍需在表单点「上传」完成人机校验）。
  // 支持：.json 模板、.pulse 波形文件，以及含 .json/.pulse 的 .zip 压缩包。
  const importTemplate = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      if (/\.zip$/i.test(file.name)) {
        const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
        const names = Object.keys(entries).filter((n) => !n.startsWith('__'));
        const jsonName = names.find((n) => /\.json$/i.test(n));
        const pulseName = names.find((n) => /\.pulse$/i.test(n));
        if (jsonName) {
          const t = applyTemplate(JSON.parse(strFromU8(entries[jsonName]!)) as Record<string, unknown>);
          // 同包内若另带 .pulse，且是波形，用原始 pulse 文本覆盖并预览
          if (pulseName && t === 'waveform') tryPreview(strFromU8(entries[pulseName]!));
        } else if (pulseName) {
          // 只有 .pulse：按波形导入
          importPulseText(strFromU8(entries[pulseName]!), pulseName.replace(/.*\//, '').replace(/\.pulse$/i, ''));
        } else {
          throw new Error('压缩包里没有 .json 模板或 .pulse 文件');
        }
      } else if (/\.pulse$/i.test(file.name)) {
        importPulseText(await file.text(), file.name.replace(/\.pulse$/i, ''));
      } else {
        applyTemplate(JSON.parse(await file.text()) as Record<string, unknown>);
      }
      setError('');
    } catch (e) {
      setError(`模板解析失败：${(e as Error).message}`);
    } finally {
      if (tplRef.current) tplRef.current.value = '';
    }
  };

  // 把一段 .pulse 文本当作波形回填（名称留空时用内嵌名 / 文件名）。
  const importPulseText = (text: string, fallbackName: string) => {
    setType('waveform');
    const { name: pulseName } = parsePulseText(text);
    if (!name.trim()) setName(pulseName || fallbackName);
    tryPreview(text);
  };

  // 把一份 JSON 文本解析成条目数组：支持「单条对象」或「数组」。
  const parseItemsJson = (text: string): unknown[] => {
    const data = JSON.parse(text) as unknown;
    return Array.isArray(data) ? data : [data];
  };

  // 批量上传：一个 .json（数组/单条）或 .zip（内含多个 .json，每个可为数组）。
  const batchUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError('');
    setBatchMsg('');
    try {
      let items: unknown[] = [];
      if (/\.zip$/i.test(file.name)) {
        const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
        for (const n of Object.keys(entries)) {
          if (n.startsWith('__') || !/\.json$/i.test(n)) continue;
          items.push(...parseItemsJson(strFromU8(entries[n]!)));
        }
        if (items.length === 0) throw new Error('压缩包里没有找到 .json 文件');
      } else {
        items = parseItemsJson(await file.text());
      }
      if (items.length === 0) throw new Error('没有可上传的条目');
      if (items.length > 50) throw new Error(`一次最多 50 条，当前 ${items.length} 条`);

      setBusy(true);
      const { inserted } = await batchUploadItems(items as BatchUploadPayload);
      setBatchMsg(`✅ 已成功上传 ${inserted} 条`);
      onUploaded();
    } catch (e) {
      setError(`批量上传失败：${(e as Error).message}`);
      setBusy(false);
    } finally {
      if (batchRef.current) batchRef.current.value = '';
    }
  };

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
        };
      } else {
        if (!setting.trim()) return setError('请填写世界观');
        const cleanRoles = roles
          .filter((r) => r.name.trim())
          .map((r) => ({
            name: r.name.trim(),
            description: r.description.trim() || undefined,
            aiPlayable: r.aiPlayable || undefined,
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

        {/* 模板：下载 → 离线填好 → 导入回填表单 */}
        <div className="tpl-row">
          <button type="button" className="btn tpl-btn" onClick={downloadTemplate}>
            ⬇ 下载模板
          </button>
          <button
            type="button"
            className="btn tpl-btn"
            onClick={() => tplRef.current?.click()}
            title="支持 .json 模板 / .pulse 波形 / 含两者的 .zip 压缩包"
          >
            ⬆ 导入模板 / 压缩包
          </button>
          <input
            ref={tplRef}
            type="file"
            accept=".json,.zip,.pulse,application/json,application/zip"
            style={{ display: 'none' }}
            onChange={(e) => importTemplate(e.target.files)}
          />
          <button
            type="button"
            className="btn tpl-btn"
            onClick={() => batchRef.current?.click()}
            disabled={busy}
            title="一个 .json（数组/单条）或 .zip（内含多个 .json），一次最多 50 条，直接上传"
          >
            📦 批量上传
          </button>
          <input
            ref={batchRef}
            type="file"
            accept=".json,.zip,application/json,application/zip"
            style={{ display: 'none' }}
            onChange={(e) => batchUpload(e.target.files)}
          />
        </div>
        <p className="upload-note">
          批量上传：选一个 JSON 数组或含多个 JSON 的压缩包，校验通过即直接发布（最多 50 条）。
        </p>
        {batchMsg && <p className="upload-ok">{batchMsg}</p>}

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
                        maxLength={2000}
                        placeholder={r.aiPlayable ? '角色描述 / AI 人设（性格、口吻、动机…）' : '角色描述（可选）'}
                      />
                      <label className="role-ai" title="该角色可由 AI 扮演（用描述当人设）">
                        <input type="checkbox" checked={r.aiPlayable} onChange={(e) => updateRole(i, { aiPlayable: e.target.checked })} />
                        AI
                      </label>
                      <button type="button" className="icon-btn" onClick={() => removeRole(i)} disabled={roles.length <= 1}>
                        ✕
                      </button>
                    </div>
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
