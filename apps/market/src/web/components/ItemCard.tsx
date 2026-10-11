import type { JSX } from 'react';
import {
  isExtraLargeScenario,
  promptKind,
  type MarketItem,
  type WaveformContent,
  type ScenarioContent,
} from '../../shared/schema';
import { WaveformPreview } from './WaveformPreview';
import { characterPortraitUrl } from '../api';

interface Props {
  item: MarketItem;
  onOpen: (item: MarketItem) => void;
}

export function ItemCard({ item, onOpen }: Props): JSX.Element {
  const portraitId =
    item.type === 'scenario' ? (item.content as ScenarioContent).portraitId : undefined;
  return (
    <button className="card" onClick={() => onOpen(item)}>
      <div className="card-head">
        <span className="card-icon">
          {portraitId ? (
            <img src={characterPortraitUrl(portraitId)} alt="" loading="lazy" />
          ) : item.type === 'waveform' ? (
            '〰️'
          ) : (
            item.icon || '🎭'
          )}
        </span>
        <span className="card-name">{item.name}</span>
        {item.type === 'scenario' && (
          <span className="agent-badge">
            {promptKind(item.content as ScenarioContent) === 'character' ? '角色' : '场景'}
          </span>
        )}
        {item.type === 'scenario' && isExtraLargeScenario(item.content as ScenarioContent) && (
          <span className="scale-badge">超大场景</span>
        )}
        {item.type === 'waveform' && (
          <span className="agent-badge">
            {(item.content as WaveformContent).modality === 'vibration' ? '震动' : '电击'}
          </span>
        )}
      </div>

      {item.type === 'waveform' ? (
        <WaveformPreview frames={(item.content as WaveformContent).frames} />
      ) : (
        <p className="card-desc">{item.description || '（无简介）'}</p>
      )}

      <div className="card-foot">
        <span className="card-author">
          {item.verifiedCreator
            ? `✓ @${item.verifiedCreator.username}`
            : item.author
              ? `署名：${item.author}`
              : '未认证作者'}
        </span>
        <span className="card-stats">
          👁 {item.views} · ↓ {item.downloads}
        </span>
      </div>
      {item.recommendationReason && (
        <p className="text-xs text-[var(--text-soft)]">{item.recommendationReason}</p>
      )}
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
