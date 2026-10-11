import { useEffect, useState } from 'react';
import {
  fetchCreatorMarketItems,
  type MarketItem,
  type MarketScenarioContent,
} from '@0xnullai/market-client';
import { ProfileSection } from './frame';

function workKind(item: MarketItem): string {
  if (item.type === 'waveform') return '波形';
  const card =
    item.content && typeof item.content === 'object'
      ? (item.content as MarketScenarioContent)
      : null;
  return card?.kind === 'character' || card?.characterCard ? '角色' : '场景';
}

/** Verified Market claims, filtered again for current public visibility by Market. */
export function ProfileWorks({
  creatorId,
  viewerId,
  onOpen,
}: {
  creatorId: string;
  viewerId: string;
  onOpen?: (id: string) => void;
}) {
  const [items, setItems] = useState<MarketItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetchCreatorMarketItems(creatorId, viewerId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setItems(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [creatorId, viewerId]);
  if (failed) return <p className="text-xs text-[var(--text-faint)]">公开作品暂不可用</p>;
  if (!items?.length) return null;
  return (
    <ProfileSection title="公开作品">
      <div className="grid gap-2 sm:grid-cols-2">
        {items.slice(0, 8).map((item) => (
          <a
            key={item.id}
            href={`/market?item=${encodeURIComponent(item.id)}`}
            onClick={(event) => {
              if (!onOpen) return;
              event.preventDefault();
              onOpen(item.id);
            }}
            className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3 hover:bg-[var(--bg-soft)]"
          >
            <span className="block truncate text-sm font-medium">
              {item.icon ? `${item.icon} ` : ''}
              {item.name}
            </span>
            <span className="text-xs text-[var(--text-faint)]">{workKind(item)}</span>
          </a>
        ))}
      </div>
    </ProfileSection>
  );
}
