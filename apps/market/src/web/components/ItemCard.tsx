import type { JSX } from 'react';
import { BadgeCheck, Download, Eye } from 'lucide-react';
import {
  isExtraLargeScenario,
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

/**
 * One card: the picture, the name, a two-line intro, then author and counts. The kind is
 * not repeated here because the category tab above already says it; an empty intro is
 * left out rather than filled with a placeholder.
 */
export function ItemCard({ item, onOpen }: Props): JSX.Element {
  const scenario = item.type === 'scenario' ? (item.content as ScenarioContent) : null;
  const waveform = item.type === 'waveform' ? (item.content as WaveformContent) : null;
  const portraitId = scenario?.portraitId;
  const description = item.description?.trim();
  return (
    <button type="button" className="card ui-press" onClick={() => onOpen(item)}>
      <span className="card-art" aria-hidden="true">
        {portraitId ? (
          <img src={characterPortraitUrl(portraitId)} alt="" loading="lazy" />
        ) : waveform ? (
          <WaveformPreview frames={waveform.frames} height={72} />
        ) : (
          <span className="card-emoji">{item.icon || '🎭'}</span>
        )}
        {waveform && (
          <span className="card-badge">{waveform.modality === 'vibration' ? '震动' : '电击'}</span>
        )}
        {scenario && isExtraLargeScenario(scenario) && (
          <span className="card-badge card-badge-warning">超大场景</span>
        )}
      </span>
      <span className="card-body">
        <span className="card-name">{item.name}</span>
        {description ? <span className="card-desc">{description}</span> : null}
        {item.recommendationReason ? (
          <span className="card-reason">{item.recommendationReason}</span>
        ) : null}
        <span className="card-foot">
          <span className="card-author">
            {item.verifiedCreator ? (
              <>
                <BadgeCheck className="h-3 w-3 shrink-0" aria-label="已认证" />@
                {item.verifiedCreator.username}
              </>
            ) : (
              item.author || '未认证作者'
            )}
          </span>
          <span className="card-stats">
            <Eye className="h-3 w-3" aria-label="浏览" />
            {item.views}
            <Download className="h-3 w-3" aria-label="下载" />
            {item.downloads}
          </span>
        </span>
      </span>
    </button>
  );
}
