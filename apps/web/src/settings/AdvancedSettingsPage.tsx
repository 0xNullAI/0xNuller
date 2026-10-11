import type { ComponentType } from 'react';
import { ChevronRight } from 'lucide-react';
import { ExperimentalDeviceSection } from './ExperimentalDeviceSection';
import { ProxySection } from './ProxySection';

export interface AdvancedSettingsEntry {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

/**
 * 高级设置: the rarely used pages and switches, kept off the 我的 overview. One flat page:
 * a list of the pages, then the global switches under plain headings.
 */
export function AdvancedSettingsPage({
  entries,
  onNavigate,
}: {
  entries: readonly AdvancedSettingsEntry[];
  onNavigate: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      {entries.length > 0 ? (
        <div className="overflow-hidden rounded-2xl bg-[var(--bg-elevated)]">
          {entries.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm hover:bg-[var(--bg-soft)] ${index > 0 ? 'border-t border-[var(--surface-border)]' : ''}`}
              >
                {Icon ? <Icon className="h-5 w-5 shrink-0 text-[var(--accent)]" /> : null}
                <span className="min-w-0 flex-1">{item.label}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
              </button>
            );
          })}
        </div>
      ) : null}
      <ProxySection />
      <ExperimentalDeviceSection />
    </div>
  );
}
