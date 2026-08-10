import type { JSX } from 'react';
import { useRef, useState } from 'react';
import { Overlay } from '@0xnullai/ui';
import { unzipSync, strFromU8 } from 'fflate';
import type { BatchUploadPayload, ItemType, UploadPayload } from '../../shared/schema';
import { parsePulseText } from '../../shared/pulse';
import { batchUploadItems, uploadItem } from '../api';
import { WaveformPreview } from './WaveformPreview';

type Frame = [number, number];

// Pull the .pulse text out of an uploaded file: read a .pulse directly, take the first
// .pulse entry out of a .zip.
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
  onUploaded: () => void; // manual single-item upload succeeded -> close and refresh
  onChanged: () => void; // file batch upload succeeded -> refresh the list (stay open so the results are visible / more can be uploaded)
}

// Parse waveform frames out of user input: accepts .pulse text, or a frames JSON array
// pasted directly.
function parseWaveInput(text: string): { frames: Frame[]; pulse?: string } {
  const trimmed = text.trim();
  if (/^Dungeonlab\+pulse:/i.test(trimmed)) {
    const { frames } = parsePulseText(trimmed);
    return { frames: frames as Frame[], pulse: trimmed };
  }
  // Try it as JSON: either {frames:[...]} or a bare [[f,s],...]
  const data = JSON.parse(trimmed) as unknown;
  const frames = Array.isArray(data) ? data : (data as { frames?: unknown }).frames;
  if (!Array.isArray(frames)) throw new Error('JSON 中找不到 frames 数组');
  return { frames: frames as Frame[] };
}

export function UploadDialog({ onClose, onUploaded, onChanged }: Props): JSX.Element {
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
  const [manual, setManual] = useState(false); // whether the manual entry form is expanded (advanced option)
  const [preview, setPreview] = useState<Frame[] | null>(null);
  // —— multiplayer scene fields ——
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
  const removeRole = (i: number) =>
    setRoles((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));
  const uploadRef = useRef<HTMLInputElement>(null);

  // Trigger a browser download of a piece of text.
  const downloadText = (filename: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // JSON template for the current type: filled in with sample content that uploads as-is,
  // so the user just edits the fields.
  // Fields common to all types: name (required) / author (uploader nickname) /
  // description / tags.
  const templateFor = (t: ItemType): unknown => {
    if (t === 'waveform')
      return {
        type: 'waveform',
        name: '示例波形 · 渐强脉冲',
        author: '你的昵称（可选，留空则匿名）',
        description: '由弱到强再回落的循环脉冲，适合作为前戏铺垫。',
        tags: ['渐强', '节奏感'],
        // frames: [encodedFrequency(10..240), strength(0..100)], one frame is about 25ms. Can be swapped for pulse text instead.
        content: {
          frames: [
            [10, 20],
            [15, 40],
            [20, 60],
            [25, 80],
            [20, 60],
            [15, 40],
          ],
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
        aiMode: 'none', // none = humans only / solo = a single AI / multi = several AIs
        roles: [
          {
            name: '避难所主管',
            description: '掌握物资分配权的冷静领袖，信奉秩序高于一切。',
            aiPlayable: false,
          },
          {
            name: '流浪医生',
            description: '唯一懂医术的外来者，立场暧昧、动机成谜。',
            aiPlayable: true,
          },
        ],
      },
    };
  };

  const downloadTemplate = () => {
    const fn =
      type === 'waveform'
        ? '波形模板.json'
        : type === 'scenario'
          ? '单人场景模板.json'
          : '多人场景模板.json';
    downloadText(fn, JSON.stringify(templateFor(type), null, 2));
  };

  // —— Upload: zip / single JSON / single .pulse are all detected automatically and
  // published through the same batch path ——

  const baseName = (n: string) => n.replace(/.*\//, '');

  // One piece of .pulse text -> one waveform item (name taken from the embedded name,
  // falling back to the file name).
  const pulseToItem = (text: string, fallbackName: string): unknown => {
    const { frames, name: embedded } = parsePulseText(text);
    return { type: 'waveform', name: embedded || fallbackName, content: { frames, pulse: text } };
  };

  // One piece of JSON text -> an array of items (a single object -> [object], an array ->
  // as-is).
  const parseItemsJson = (text: string): unknown[] => {
    const data = JSON.parse(text) as unknown;
    return Array.isArray(data) ? data : [data];
  };

  // If a waveform item references a .pulse inside the archive by file name (content.pulse /
  // pulse / file), or gives the pulse text directly, parse out the frames and fill them in
  // automatically; otherwise pass it through unchanged for the backend to validate.
  const resolveWaveItem = (
    it: Record<string, unknown>,
    pulseMap: Record<string, string>,
    used: Set<string>,
  ): unknown => {
    if (it.type !== 'waveform') return it;
    const c = (it.content ?? {}) as Record<string, unknown>;
    if (Array.isArray(c.frames) && c.frames.length) return it; // frames already inlined
    const candidates = [c.pulse, (it as { file?: unknown }).file, (c as { file?: unknown }).file];
    for (const cand of candidates) {
      if (typeof cand !== 'string') continue;
      const key = baseName(cand);
      if (pulseMap[key]) {
        used.add(key);
        const text = pulseMap[key]!;
        return { ...it, content: { ...c, frames: parsePulseText(text).frames, pulse: text } };
      }
      if (/^Dungeonlab\+pulse:/i.test(cand)) {
        return { ...it, content: { ...c, frames: parsePulseText(cand).frames, pulse: cand } };
      }
    }
    return it;
  };

  // Any uploaded file -> an array of items to publish.
  const parseUploadFile = async (file: File): Promise<unknown[]> => {
    if (/\.zip$/i.test(file.name)) {
      const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
      const names = Object.keys(entries).filter(
        (n) => !baseName(n).startsWith('__') && !n.endsWith('/'),
      );
      const pulseMap: Record<string, string> = {};
      for (const n of names)
        if (/\.pulse$/i.test(n)) pulseMap[baseName(n)] = strFromU8(entries[n]!);
      const used = new Set<string>();
      const items: unknown[] = [];
      for (const n of names) {
        if (!/\.json$/i.test(n)) continue;
        for (const it of parseItemsJson(strFromU8(entries[n]!)))
          items.push(resolveWaveItem((it ?? {}) as Record<string, unknown>, pulseMap, used));
      }
      // Each .pulse not referenced by any JSON becomes a waveform item of its own
      for (const [key, text] of Object.entries(pulseMap))
        if (!used.has(key)) items.push(pulseToItem(text, key.replace(/\.pulse$/i, '')));
      return items;
    }
    if (/\.pulse$/i.test(file.name)) {
      return [pulseToItem(await file.text(), file.name.replace(/\.pulse$/i, ''))];
    }
    return parseItemsJson(await file.text()).map((it) =>
      resolveWaveItem((it ?? {}) as Record<string, unknown>, {}, new Set()),
    );
  };

  // The 「上传」 button: pick a file -> parse automatically -> publish as a batch (both
  // single and multiple items go through here).
  const smartUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError('');
    setBatchMsg('');
    try {
      const items = await parseUploadFile(file);
      if (items.length === 0) throw new Error('文件里没有可上传的条目');
      if (items.length > 50) throw new Error(`一次最多 50 条，当前 ${items.length} 条`);
      setBusy(true);
      const { inserted } = await batchUploadItems(items as BatchUploadPayload);
      setBatchMsg(`✅ 已成功上传 ${inserted} 条`);
      onChanged();
    } catch (e) {
      setError(`上传失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  };

  const handleFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError('');
    try {
      const { text, embeddedName } = await readPulseFromFile(file);
      const { name: pulseName } = parsePulseText(text); // validate and take the embedded name
      tryPreview(text);
      // When the name is empty, autofill it from the waveform's embedded name / the file name
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
      .slice(0, 20);

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
        // Single-player scenes always carry the 'DG Agent' tag (deduped, capped at 20).
        const scenarioTags = tags.includes('DG Agent') ? tags : ['DG Agent', ...tags].slice(0, 20);
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
          content: {
            setting: setting.trim(),
            roles: cleanRoles,
            playerCount: { min: mn, max: mx },
            aiMode,
          },
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
    <Overlay onDismiss={onClose} className="mkt-scope">
      <div role="dialog" aria-modal="true" aria-labelledby="market-upload-title" className="modal">
        <header className="modal-head">
          <h2 id="market-upload-title">上传到市场</h2>
          <button type="button" className="icon-btn" aria-label="关闭上传" onClick={onClose}>
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
            <button
              className={type === 'waveform' ? 'active' : ''}
              onClick={() => setType('waveform')}
            >
              波形
            </button>
          </div>
          {(type === 'scenario' || type === 'multi-scene') && (
            <div className="seg seg-sub">
              <button
                className={type === 'scenario' ? 'active' : ''}
                onClick={() => setType('scenario')}
              >
                单人
              </button>
              <button
                className={type === 'multi-scene' ? 'active' : ''}
                onClick={() => setType('multi-scene')}
              >
                多人
              </button>
            </div>
          )}
        </div>
        {/* Main flow: download the latest template -> fill it in offline -> upload (a single
          file or an archive, batches detected automatically) */}
        <div className="tpl-row">
          <button type="button" className="btn tpl-btn" onClick={downloadTemplate}>
            ⬇ 下载模板
          </button>
          <button
            type="button"
            className="btn primary tpl-btn"
            onClick={() => uploadRef.current?.click()}
            disabled={busy}
            title="选单个 JSON 文件或压缩包，自动识别单条 / 多条并直接发布（最多 50 条）"
          >
            {busy ? '上传中…' : '⬆ 上传（JSON / 压缩包）'}
          </button>
          <input
            ref={uploadRef}
            type="file"
            accept=".json,.zip,.pulse,application/json,application/zip"
            style={{ display: 'none' }}
            onChange={(e) => smartUpload(e.target.files)}
          />
        </div>
        <p className="upload-note">
          下载模板填好后点「上传」选文件即可：单个 JSON、JSON 数组、或含多个 JSON / .pulse
          的压缩包都自动识别，校验通过直接发布（最多 50 条）。
        </p>
        {batchMsg && <p className="upload-ok">{batchMsg}</p>}

        <button
          type="button"
          className="btn ghost manual-toggle"
          onClick={() => setManual((m) => !m)}
        >
          {manual ? '收起手动填写' : '✏️ 或手动填写一条'}
        </button>

        {manual && (
          <>
            {type === 'scenario' && (
              <p className="upload-note">单人场景会自动标记，供 Agent 导入。</p>
            )}
            <label className="field">
              <span>名称 *</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </label>

            <div className="row">
              <label className="field">
                <span>昵称（可选）</span>
                <input
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  maxLength={30}
                  placeholder="匿名"
                />
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
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
              />
            </label>

            <label className="field">
              <span>标签（逗号分隔，可选）</span>
              <input
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="温柔, 节奏感"
              />
            </label>

            <p className="upload-note">内容会保存到当前登录账户，可在其他设备继续管理。</p>

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
                    <small>
                      {preview.length} 帧 · {(preview.length * 25) / 1000}s
                    </small>
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
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={playerMin}
                      onChange={(e) => setPlayerMin(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>推荐人数（最多）★</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={playerMax}
                      onChange={(e) => setPlayerMax(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>AI 参与</span>
                    <select
                      value={aiMode}
                      onChange={(e) => setAiMode(e.target.value as 'none' | 'solo' | 'multi')}
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
                            placeholder={
                              r.aiPlayable
                                ? '角色描述 / AI 人设（性格、口吻、动机…）'
                                : '角色描述（可选）'
                            }
                          />
                          <label className="role-ai" title="该角色可由 AI 扮演（用描述当人设）">
                            <input
                              type="checkbox"
                              checked={r.aiPlayable}
                              onChange={(e) => updateRole(i, { aiPlayable: e.target.checked })}
                            />
                            AI
                          </label>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`删除角色 ${i + 1}`}
                            onClick={() => removeRole(i)}
                            disabled={roles.length <= 1}
                          >
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
          </>
        )}

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        <div className="modal-actions">
          {manual && (
            <button className="btn primary" onClick={submit} disabled={busy}>
              {busy ? '上传中…' : '上传这一条'}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            {manual ? '取消' : '关闭'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
