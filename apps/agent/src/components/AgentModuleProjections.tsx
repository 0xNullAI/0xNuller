import { type ComponentProps } from 'react';
import { AudioWaveform, Database } from 'lucide-react';
import { ModuleSettingsSection } from '@0xnullai/ui';
import { DataTab } from './settings/DataTab.js';
import { SensorsTab } from './settings/SensorsTab.js';
import { WaveformsPanel } from './WaveformsPanel.js';

export interface AgentModuleProjectionsProps {
  sensors: ComponentProps<typeof SensorsTab>;
  waveforms: ComponentProps<typeof WaveformsPanel>;
  data: ComponentProps<typeof DataTab>;
}

/**
 * Projects Agent-owned settings into the unified shell.
 *
 * The app coordinator prepares every view model and action. This component only
 * registers those projections;
 * it does not coordinate sessions, devices, permissions, or persistence.
 */
export function AgentModuleProjections({
  sensors,
  waveforms,
  data,
}: AgentModuleProjectionsProps) {
  return (
    <>
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
