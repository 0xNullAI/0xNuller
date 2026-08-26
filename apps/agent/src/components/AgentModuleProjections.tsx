import { useState, type ComponentProps } from 'react';
import { AudioWaveform, Bug, Database } from 'lucide-react';
import { ModuleSettingsSection } from '@0xnullai/ui';
import { DataTab } from './settings/DataTab.js';
import { DebugPanel } from './DebugPanel.js';
import { SensorsTab } from './settings/SensorsTab.js';
import { WaveformsPanel } from './WaveformsPanel.js';

type DebugPanelProps = ComponentProps<typeof DebugPanel>;

export interface AgentModuleProjectionsProps {
  debug: Omit<DebugPanelProps, 'onClose'>;
  sensors: ComponentProps<typeof SensorsTab>;
  waveforms: ComponentProps<typeof WaveformsPanel>;
  data: ComponentProps<typeof DataTab>;
}

/**
 * Projects Agent-owned diagnostics and settings into the unified shell.
 *
 * The app coordinator prepares every view model and action. This component only
 * registers those projections and owns the debug dialog's visual open state;
 * it does not coordinate sessions, devices, permissions, or persistence.
 */
export function AgentModuleProjections({
  debug,
  sensors,
  waveforms,
  data,
}: AgentModuleProjectionsProps) {
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);

  return (
    <>
      <ModuleSettingsSection id="agent-diagnostics" label="诊断" icon={Bug} order={70}>
        <button
          type="button"
          onClick={() => setDebugPanelOpen(true)}
          aria-label="打开调试面板"
          className="flex min-h-10 w-full items-center gap-2 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 text-sm font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          <Bug className="h-4 w-4" />
          打开调试面板
        </button>
      </ModuleSettingsSection>

      {debugPanelOpen && <DebugPanel {...debug} onClose={() => setDebugPanelOpen(false)} />}

      <ModuleSettingsSection id="agent-sensors" label="传感器" navigation={false}>
        <SensorsTab {...sensors} />
      </ModuleSettingsSection>

      <ModuleSettingsSection id="agent-waveforms" label="波形" icon={AudioWaveform} order={30}>
        <WaveformsPanel {...waveforms} />
      </ModuleSettingsSection>

      <ModuleSettingsSection id="agent-data" label="数据" icon={Database} order={60}>
        <DataTab {...data} />
      </ModuleSettingsSection>
    </>
  );
}
