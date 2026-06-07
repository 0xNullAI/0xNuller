import type { MarketItem, WaveformContent } from '../../shared/schema';
import { WaveformPreview } from './WaveformPreview';

interface Props {
  item: MarketItem;
  onOpen: (item: MarketItem) => void;
}

export function ItemCard({ item, onOpen }: Props): JSX.Element {
  return (
    <button className="card" onClick={() => onOpen(item)}>
      <div className="card-head">
        <span className="card-icon">{item.type === 'scenario' ? item.icon || '🎭' : '〰️'}</span>
        <span className="card-name">{item.name}</span>
      </div>

      {item.type === 'waveform' ? (
        <WaveformPreview frames={(item.content as WaveformContent).frames} />
      ) : (
        <p className="card-desc">{item.description || '（无简介）'}</p>
      )}

      <div className="card-foot">
        <span className="card-author">{item.author ? `@${item.author}` : '匿名'}</span>
        <span className="card-dl">↓ {item.downloads}</span>
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
