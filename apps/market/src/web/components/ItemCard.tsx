import type { JSX } from 'react';
import type { MarketItem, WaveformContent, MultiSceneContent } from '../../shared/schema';
import { WaveformPreview } from './WaveformPreview';

interface Props {
  item: MarketItem;
  onOpen: (item: MarketItem) => void;
}

export function ItemCard({ item, onOpen }: Props): JSX.Element {
  return (
    <button className="card" onClick={() => onOpen(item)}>
      <div className="card-head">
        <span className="card-icon">
          {item.type === 'waveform' ? '〰️' : item.icon || (item.type === 'multi-scene' ? '🎬' : '🎭')}
        </span>
        <span className="card-name">{item.name}</span>
        {item.type === 'scenario' && <span className="agent-badge">DG Agent</span>}
        {item.type === 'multi-scene' && (item.content as MultiSceneContent).playerCount && (
          <span className="player-badge">
            👥 {(item.content as MultiSceneContent).playerCount!.min}-
            {(item.content as MultiSceneContent).playerCount!.max} 人
          </span>
        )}
      </div>

      {item.type === 'waveform' ? (
        <WaveformPreview frames={(item.content as WaveformContent).frames} />
      ) : item.type === 'multi-scene' ? (
        <div className="card-scene">
          <p className="card-desc">{item.description || '（无简介）'}</p>
          <div className="scene-meta">
            <span>🎭 {(item.content as MultiSceneContent).roles.length} 角色</span>
            {(item.content as MultiSceneContent).playerCount && (
              <span>
                👥 {(item.content as MultiSceneContent).playerCount!.min}-
                {(item.content as MultiSceneContent).playerCount!.max} 人
              </span>
            )}
          </div>
        </div>
      ) : (
        <p className="card-desc">{item.description || '（无简介）'}</p>
      )}

      <div className="card-foot">
        <span className="card-author">{item.author ? `@${item.author}` : '匿名'}</span>
        <span className="card-stats">
          👁 {item.views} · ↓ {item.downloads}
        </span>
      </div>
      {item.tags.length > 0 && (
        <div className="tags">
          {item.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
