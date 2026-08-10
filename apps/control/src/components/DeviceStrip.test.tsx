import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CoyoteSummary } from '../../../chat/src/lib/bluetooth';
import { DeviceStrip } from './DeviceStrip';

function coyote(id: string): CoyoteSummary {
  return {
    id,
    name: '47L121000',
    version: 'v3',
    connected: true,
    battery: 80,
    strengthA: 0,
    strengthB: 0,
    limitA: 30,
    limitB: 30,
    waveActiveA: false,
    waveActiveB: false,
    waveIdA: null,
    waveIdB: null,
  };
}

describe('DeviceStrip 设备标签', () => {
  it('不显示原始蓝牙名，多台同类设备改用序号', () => {
    render(
      <DeviceStrip
        coyotes={[coyote('one'), coyote('two')]}
        sensor={null}
        opossum={null}
        limitA={30}
        limitB={30}
        onSetLimit={vi.fn()}
        onConnectDevice={vi.fn(async () => ({ kind: 'coyote' as const, name: '' }))}
        onDisconnectCoyote={vi.fn()}
        onDisconnectSensor={vi.fn()}
        onDisconnectOpossum={vi.fn()}
        onRestoreDefaults={vi.fn()}
      />,
    );

    expect(screen.queryByText('47L121000')).toBeNull();
    expect(screen.getByText('郊狼 1')).toBeTruthy();
    expect(screen.getByText('郊狼 2')).toBeTruthy();
  });
});
