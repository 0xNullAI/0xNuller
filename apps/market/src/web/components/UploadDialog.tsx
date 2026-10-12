import type { JSX } from 'react';
import { useRef, useState } from 'react';
import { Overlay } from '@0xnullai/ui';
import { parsePulseText } from '../../shared/pulse';
import { BatchUploadSchema } from '../../shared/schema';
import { batchUploadItems, uploadItem } from '../api';
import {
  buildManualUploadPayload,
  createUploadTemplate,
  parseUploadFile,
  parseWaveInput,
  readPulseFromFile,
  type Frame,
  type WaveformModality,
} from '../upload-model';
import { WaveformPreview } from './WaveformPreview';

interface Props {
  onClose: () => void;
  onUploaded: () => void;
  onChanged: () => void;
}

/** Waveform publishing; prompt cards use the single page editor. */
export function UploadDialog({ onClose, onUploaded, onChanged }: Props): JSX.Element {
  const [modality, setModality] = useState<WaveformModality>('electrostimulation');
  const [name, setName] = useState('');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [waveInput, setWaveInput] = useState('');
  const [preview, setPreview] = useState<Frame[] | null>(null);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [batchMessage, setBatchMessage] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);
  const pulseRef = useRef<HTMLInputElement>(null);

  function downloadTemplate() {
    const blob = new Blob([JSON.stringify(createUploadTemplate('waveform', modality), null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '波形模板.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function uploadFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError('');
    setBatchMessage('');
    setBusy(true);
    try {
      const items = await parseUploadFile(file, modality);
      if (!items.length || items.length > 50) throw new Error('一次需上传 1–50 条波形');
      if (
        items.some(
          (item) => item && typeof item === 'object' && 'type' in item && item.type !== 'waveform',
        )
      )
        throw new Error('这里只能上传波形；角色和场景请使用创建编辑器');
      const parsed = BatchUploadSchema.safeParse(items);
      if (!parsed.success) throw new Error('文件格式不符合公开内容要求');
      const result = await batchUploadItems(parsed.data);
      setBatchMessage(`已上传 ${result.inserted} 条波形`);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传失败');
    } finally {
      setBusy(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  }

  function updateWave(text: string) {
    setWaveInput(text);
    setError('');
    if (!text.trim()) return setPreview(null);
    try {
      setPreview(parseWaveInput(text).frames);
    } catch (reason) {
      setPreview(null);
      setError(reason instanceof Error ? reason.message : '波形解析失败');
    }
  }

  async function readPulse(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      const { text, embeddedName } = await readPulseFromFile(file);
      updateWave(text);
      if (!name.trim()) setName(parsePulseText(text).name || embeddedName);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '文件解析失败');
    } finally {
      if (pulseRef.current) pulseRef.current.value = '';
    }
  }

  async function submit() {
    setError('');
    let payload;
    try {
      payload = buildManualUploadPayload({
        type: 'waveform',
        waveformModality: modality,
        name,
        author,
        description,
        icon: '',
        tagsText,
        waveInput,
        prompt: '',
        characterCard: undefined,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '波形数据无效');
      return;
    }
    setBusy(true);
    try {
      await uploadItem(payload);
      onUploaded();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传失败');
      setBusy(false);
    }
  }

  return (
    <Overlay onDismiss={onClose} className="mkt-scope">
      <div role="dialog" aria-modal="true" aria-labelledby="market-upload-title" className="modal">
        <header className="modal-head">
          <h2 id="market-upload-title">发布波形</h2>
          <button type="button" className="icon-btn" aria-label="关闭上传" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="seg seg-sub" aria-label="波形类型">
          <button
            type="button"
            className={modality === 'electrostimulation' ? 'active' : ''}
            onClick={() => setModality('electrostimulation')}
          >
            电击
          </button>
          <button
            type="button"
            className={modality === 'vibration' ? 'active' : ''}
            onClick={() => setModality('vibration')}
          >
            震动
          </button>
        </div>
        <div className="tpl-row">
          <button type="button" className="btn tpl-btn" onClick={downloadTemplate}>
            下载波形模板
          </button>
          <button
            type="button"
            className="btn primary tpl-btn"
            disabled={busy}
            onClick={() => uploadRef.current?.click()}
          >
            {busy ? '上传中…' : '上传 JSON / ZIP / PULSE'}
          </button>
          <input
            ref={uploadRef}
            type="file"
            accept=".json,.zip,.pulse,application/json,application/zip"
            style={{ display: 'none' }}
            onChange={(event) => void uploadFiles(event.target.files)}
          />
        </div>
        <p className="upload-note">可上传单条或最多 50 条波形；角色与场景请在发现页创建。</p>
        {batchMessage && <p className="upload-ok">{batchMessage}</p>}
        <button
          type="button"
          className="btn ghost manual-toggle"
          onClick={() => setManual((value) => !value)}
        >
          {manual ? '收起手动填写' : '手动填写一条'}
        </button>
        {manual && (
          <>
            <label className="field">
              <span>名称 *</span>
              <input
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              <span>作品署名（可选）</span>
              <input
                value={author}
                maxLength={30}
                onChange={(event) => setAuthor(event.target.value)}
              />
              <small>发布账户会公开显示；此处只填写作品的额外署名。</small>
            </label>
            <label className="field">
              <span>简介（可选）</span>
              <input
                value={description}
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="field">
              <span>标签（逗号分隔）</span>
              <input value={tagsText} onChange={(event) => setTagsText(event.target.value)} />
            </label>
            <label className="field">
              <span>波形数据 *</span>
              <label className="file-drop">
                <span>选择 .pulse / .zip 文件</span>
                <input
                  ref={pulseRef}
                  type="file"
                  accept=".pulse,.zip"
                  className="file-input-hidden"
                  onChange={(event) => void readPulse(event.target.files)}
                />
              </label>
              <textarea
                rows={4}
                value={waveInput}
                onChange={(event) => updateWave(event.target.value)}
                placeholder="粘贴 Dungeonlab+pulse 文本或 frames JSON"
              />
            </label>
            {preview && (
              <div className="preview-wrap">
                <WaveformPreview frames={preview} />
                <small>{preview.length} 帧</small>
              </div>
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
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? '上传中…' : '发布波形'}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {manual ? '取消' : '关闭'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
