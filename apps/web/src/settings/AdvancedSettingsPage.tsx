import type { ComponentType } from 'react';
import { ExperimentalDeviceSection } from './ExperimentalDeviceSection';
import { ProxySection } from './ProxySection';
import { SettingsGroup, SettingsRow } from './settings-list';

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
        <SettingsGroup>
          {entries.map((item) => (
            <SettingsRow
              key={item.id}
              icon={item.icon}
              label={item.label}
              onClick={() => onNavigate(item.id)}
            />
          ))}
        </SettingsGroup>
      ) : null}
      <ProxySection />
      <ExperimentalDeviceSection />
    </div>
  );
}
