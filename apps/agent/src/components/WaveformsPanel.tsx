import { useMemo, useState } from 'react';
import type { WaveformDefinition } from '@dg-agent/core';
import { Pencil, Store, Trash2, Upload } from 'lucide-react';
import { Button, MarketImportDialog } from '@0xnullai/ui';
import type { MarketItem, MarketWaveformContent } from '@0xnullai/market-client';
import { getWaveformModality } from '@dg-kit/core';

interface WaveformsPanelProps {
  waveforms: WaveformDefinition[];
  customWaveforms: WaveformDefinition[];
  onImport: (files: FileList | null) => void;
  onImportFromMarket: (waveform: WaveformDefinition) => void | Promise<void>;
  onRemove: (id: string) => void;
  onEdit: (waveform: WaveformDefinition) => void;
}

export function WaveformsPanel({
  waveforms,
  customWaveforms,
  onImport,
  onImportFromMarket,
  onRemove,
  onEdit,
}: WaveformsPanelProps) {
  const [marketOpen, setMarketOpen] = useState(false);
  const [modalityFilter, setModalityFilter] = useState<'all' | 'electrostimulation' | 'vibration'>(
    'all',
  );
  const visibleWaveforms = useMemo(
    () =>
      waveforms.filter(
        (waveform) => modalityFilter === 'all' || getWaveformModality(waveform) === modalityFilter,
      ),
    [modalityFilter, waveforms],
  );

  async function handleMarketImport(item: MarketItem) {
    const { frames } = item.content as MarketWaveformContent;
    await onImportFromMarket({
      id: `market-${item.id}`,
      name: item.name,
      description: item.description,
      frames,
      modality: (item.content as MarketWaveformContent).modality ?? 'electrostimulation',
    });
  }

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-card">
        <h3 className="settings-card-legend">波形库</h3>

        <div className="mb-3 flex rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-0.5">
          {(
            [
              ['all', '全部'],
              ['electrostimulation', '电击'],
              ['vibration', '震动'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setModalityFilter(value)}
              className={`flex-1 rounded-[var(--radius-sm)] px-2 py-1.5 text-xs transition-colors ${
                modalityFilter === value
                  ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent)]'
                  : 'text-[var(--text-faint)] hover:bg-[var(--bg-soft)] hover:text-[var(--text-soft)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {visibleWaveforms.length === 0 && (
          <div className="py-4 text-center text-sm text-[var(--text-faint)]">
            {waveforms.length === 0 ? '还没有可用波形，点击下方按钮导入' : '此分类暂无波形'}
          </div>
        )}

        <div className="space-y-1.5">
          {visibleWaveforms.map((waveform) => {
            const isCustom = customWaveforms.some((c) => c.id === waveform.id);
            return (
              <div key={waveform.id} className="group flex items-center gap-1">
                <div className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-ctl)] px-3 py-2.5">
                  <span className="shrink-0 text-lg">{isCustom ? '📝' : '〰️'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-[var(--text)]">{waveform.name}</div>
                    <div className="mt-0.5 truncate text-[12px] text-[var(--text-faint)]">
                      {waveform.id} · {waveform.frames.length} 帧 ·{' '}
                      {getWaveformModality(waveform) === 'vibration' ? '震动' : '电击'}
                    </div>
                  </div>
                </div>
                {isCustom && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-full text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--text)]"
                    onClick={() => onEdit(waveform)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 rounded-full text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                  onClick={() => onRemove(waveform.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="!grid min-h-20 cursor-pointer grid-rows-[1.25rem_1.5rem] place-items-center gap-2 rounded-[var(--radius-ctl)] border border-dashed border-[var(--surface-border)] px-3 py-3 text-center text-sm text-[var(--text-soft)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
            <Upload className="h-4 w-4" />
            <span>导入波形文件</span>
            <input
              type="file"
              accept=".pulse,.zip"
              multiple
              className="hidden"
              onChange={(event) => onImport(event.target.files)}
            />
          </label>
          <button
            type="button"
            className="grid min-h-20 cursor-pointer grid-rows-[1.25rem_1.5rem] place-items-center gap-2 rounded-[var(--radius-ctl)] border border-dashed border-[var(--surface-border)] px-3 py-3 text-center text-sm text-[var(--text-soft)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            onClick={() => setMarketOpen(true)}
          >
            <Store className="h-4 w-4" />
            <span>从市场导入</span>
          </button>
        </div>
      </section>

      <MarketImportDialog
        open={marketOpen}
        onOpenChange={setMarketOpen}
        type="waveform"
        modality={modalityFilter === 'all' ? undefined : modalityFilter}
        onImport={handleMarketImport}
      />
    </div>
  );
}
