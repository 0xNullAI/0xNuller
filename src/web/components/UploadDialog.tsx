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
  const fileRef = useRef<HTMLInputElement>(null);

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
      } else {
        if (!prompt.trim()) return setError('请填写场景提示词');
        payload = {
          type: 'scenario',
          name: name.trim(),
          description: description.trim() || undefined,
          author: author.trim() || undefined,
          icon: icon.trim() || undefined,
          tags,
          content: { prompt: prompt.trim() },
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

        <div className="seg">
          <button className={type === 'waveform' ? 'active' : ''} onClick={() => setType('waveform')}>
            波形
          </button>
          <button className={type === 'scenario' ? 'active' : ''} onClick={() => setType('scenario')}>
            场景
          </button>
        </div>

        <label className="field">
          <span>名称 *</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>

        <div className="row">
          <label className="field">
            <span>昵称（可选）</span>
            <input value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={30} placeholder="匿名" />
          </label>
          {type === 'scenario' && (
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
        ) : (
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
