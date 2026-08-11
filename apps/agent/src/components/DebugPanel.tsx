import { useState } from 'react';
import { Bug, Radio, ScrollText, X } from 'lucide-react';
import { Overlay } from '@0xnullai/ui';
import { BridgeTab } from './settings/BridgeTab.js';
import { BridgeLogsTab, ModelLogsTab } from './settings/LogsTab.js';
import type { ComponentProps } from 'react';

/**
 * The debug panel.
 *
 * Deliberately not part of the settings panel. The bot bridge, the bridge log
 * and the model-call log are diagnostics: you open them when something is not
 * working, not when you are configuring the product. Filing them under
 * 设置 put "which QQ groups may talk to the bot" next to "how strong may the
 * device go", which are not the same kind of decision.
 *
 * It lives in Agent rather than the shared layer because all three pages read
 * this module's live state — the settings draft, the bridge's own log buffer,
 * and the in-memory model-call turns.
 */

type BridgeProps = ComponentProps<typeof BridgeTab>;
type BridgeLogsProps = ComponentProps<typeof BridgeLogsTab>;
type ModelLogsProps = ComponentProps<typeof ModelLogsTab>;

const TABS = [
  { id: 'bridge', label: 'Bot 桥接', icon: Radio },
  { id: 'bridge-logs', label: '桥接日志', icon: ScrollText },
  { id: 'model-logs', label: '模型日志', icon: ScrollText },
] as const;

export function DebugPanel({
  onClose,
  bridge,
  bridgeLogs,
  modelLogs,
}: {
  onClose: () => void;
  bridge: BridgeProps;
  bridgeLogs: BridgeLogsProps;
  modelLogs: ModelLogsProps;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('bridge');

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="调试面板"
        className="flex h-[min(680px,calc(100dvh-2rem))] w-[min(880px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-panel)] sm:flex-row"
        style={{ '--settings-surface': 'var(--bg-elevated)' } as React.CSSProperties}
      >
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--surface-border)] p-2 sm:w-[180px] sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
          <h2 className="hidden items-center gap-2 px-2 pb-2 pt-1 text-sm font-semibold sm:flex">
            <Bug className="h-4 w-4" />
            调试面板
          </h2>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={
                'flex shrink-0 items-center gap-2 rounded-[var(--radius-ctl)] px-3 py-2 text-sm transition-colors ' +
                (tab === t.id
                  ? 'bg-[var(--accent-soft)] font-medium text-[var(--text)]'
                  : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]')
              }
            >
              <t.icon className="h-4 w-4 shrink-0" />
              {t.label}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-end p-2">
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭调试面板"
              className="flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-ctl)] text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] sm:min-h-0 sm:min-w-0 sm:p-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* Same top padding as the settings panel, for the same reason: the
              section headings ride the card border and get clipped in half
              when flush against the scroll container. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-3">
            {tab === 'bridge' && <BridgeTab {...bridge} />}
            {tab === 'bridge-logs' && <BridgeLogsTab {...bridgeLogs} />}
            {tab === 'model-logs' && <ModelLogsTab {...modelLogs} />}
          </div>
        </div>
      </div>
    </Overlay>
  );
}
