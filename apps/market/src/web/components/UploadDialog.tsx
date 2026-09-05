import type { JSX } from 'react';
import { useRef, useState } from 'react';
import { Overlay } from '@0xnullai/ui';
import type { BatchUploadPayload, ItemType } from '../../shared/schema';
import { MAX_SCENARIO_PROMPT_LENGTH, STANDARD_SCENARIO_PROMPT_LENGTH } from '../../shared/schema';
import { parsePulseText } from '../../shared/pulse';
import { batchUploadItems, uploadItem } from '../api';
import {
  buildManualUploadPayload,
  createUploadTemplate,
  parseUploadFile,
  parseWaveInput,
  readPulseFromFile,
  type AiMode,
  type Frame,
  type UploadRole,
  type WaveformModality,
} from '../upload-model';
import { WaveformPreview } from './WaveformPreview';

interface Props {
  onClose: () => void;
  onUploaded: () => void; // manual single-item upload succeeded -> close and refresh
  onChanged: () => void; // file batch upload succeeded -> refresh the list (stay open so the results are visible / more can be uploaded)
}

export function UploadDialog({ onClose, onUploaded, onChanged }: Props): JSX.Element {
  const [type, setType] = useState<ItemType>('waveform');
  const [waveformModality, setWaveformModality] = useState<WaveformModality>('electrostimulation');
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
  const [aiMode, setAiMode] = useState<AiMode>('none');
  const [roles, setRoles] = useState<UploadRole[]>([
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

  const downloadTemplate = () => {
    const fn =
      type === 'waveform'
        ? '波形模板.json'
        : type === 'scenario'
          ? '单人场景模板.json'
          : '多人场景模板.json';
    downloadText(fn, JSON.stringify(createUploadTemplate(type, waveformModality), null, 2));
  };

  // The 「上传」 button: pick a file -> parse automatically -> publish as a batch (both
  // single and multiple items go through here).
  const smartUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError('');
    setBatchMsg('');
    try {
      const items = await parseUploadFile(file, waveformModality);
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

    let payload;
    try {
      payload = buildManualUploadPayload({
        type,
        waveformModality,
        name,
        author,
        description,
        icon,
        tagsText,
        waveInput,
        prompt,
        setting,
        playerMin,
        playerMax,
        aiMode,
        roles,
      });
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
          {type === 'waveform' && (
            <div className="seg seg-sub">
              <button
                className={waveformModality === 'electrostimulation' ? 'active' : ''}
                onClick={() => setWaveformModality('electrostimulation')}
              >
                电击
              </button>
              <button
                className={waveformModality === 'vibration' ? 'active' : ''}
                onClick={() => setWaveformModality('vibration')}
              >
                震动
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
              <p className="upload-note">
                单人场景会自动标记，供 Agent 导入；超过{' '}
                {STANDARD_SCENARIO_PROMPT_LENGTH.toLocaleString()} 字会额外标注为「超大场景」。
              </p>
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
              <>
                <label className="field">
                  <span>
                    场景提示词 * · {prompt.length.toLocaleString()} /{' '}
                    {MAX_SCENARIO_PROMPT_LENGTH.toLocaleString()}
                  </span>
                  <textarea
                    rows={8}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="粘贴你的自定义场景设定…"
                  />
                </label>
                {prompt.length > STANDARD_SCENARIO_PROMPT_LENGTH && (
                  <p className="upload-note extra-large-note">
                    超大场景 · 导入后会占用更多模型上下文，请选用支持长上下文的模型。
                  </p>
                )}
              </>
            ) : (
              <>
                <label className="field">
                  <span>世界观 / 背景 *</span>
                  <textarea
                    rows={5}
                    value={setting}
                    onChange={(e) => setSetting(e.target.value)}
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
                    <select value={aiMode} onChange={(e) => setAiMode(e.target.value as AiMode)}>
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
