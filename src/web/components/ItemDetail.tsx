import { useState } from 'react';
import type { MarketItem, ScenarioContent, WaveformContent, MultiSceneContent } from '../../shared/schema';
import { markDownloaded, reportItem } from '../api';
import { WaveformPreview } from './WaveformPreview';

interface Props {
  item: MarketItem;
  onClose: () => void;
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

export function ItemDetail({ item, onClose }: Props): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [reported, setReported] = useState(false);

  // DG-Agent 可直接导入的 JSON 形状。
  const exportJson = JSON.stringify(
    item.type === 'waveform'
      ? { name: item.name, description: item.description, frames: (item.content as WaveformContent).frames }
      : item.type === 'multi-scene'
        ? { name: item.name, icon: item.icon, ...(item.content as MultiSceneContent) }
        : { name: item.name, icon: item.icon, prompt: (item.content as ScenarioContent).prompt },
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
    const safe = item.name.replace(/[^\w一-龥-]+/g, '_');
    download(`${safe}.json`, exportJson);
    void markDownloaded(item.id);
  };

  const handleReport = async () => {
    await reportItem(item.id);
    setReported(true);
  };

  const pulse = item.type === 'waveform' ? (item.content as WaveformContent).pulse : undefined;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>
            {item.type === 'waveform' ? '〰️ ' : `${item.icon || (item.type === 'multi-scene' ? '🎬' : '🎭')} `}
            {item.name}
          </h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <p className="modal-meta">
          {item.type === 'waveform' ? '波形' : item.type === 'multi-scene' ? '多人场景' : '场景'} ·{' '}
          {item.author ? `@${item.author}` : '匿名'} · 👁 {item.views} · ↓ {item.downloads}
        </p>

        {item.description && <p className="modal-desc">{item.description}</p>}

        {item.type === 'waveform' ? (
          <WaveformPreview frames={(item.content as WaveformContent).frames} height={96} />
        ) : item.type === 'multi-scene' ? (
          (() => {
            const c = item.content as MultiSceneContent;
            const aiLabel = c.aiMode === 'solo' ? '单个 AI' : c.aiMode === 'multi' ? '多个 AI' : '纯人';
            return (
              <div className="scene-detail">
                <pre className="prompt-box">{c.setting}</pre>
                <div className="scene-meta">
                  {c.playerCount && <span>👥 建议 {c.playerCount.min}-{c.playerCount.max} 人</span>}
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
            <button className="btn" onClick={() => download(`${item.name}.pulse`, pulse)}>
              下载 .pulse
            </button>
          )}
          <button className="btn ghost" onClick={handleReport} disabled={reported}>
            {reported ? '已举报' : '举报'}
          </button>
        </div>

        <p className="modal-hint">
          {item.type === 'multi-scene'
            ? '在 DG-Chat 房间里点「场景 → 从市场导入」即可应用为房间场景。'
            : `在 DG-Agent 的「${item.type === 'waveform' ? '波形库' : '场景'}」面板点「从市场导入」即可直接使用；或复制 JSON 手动导入。`}
        </p>
      </div>
    </div>
  );
}
