import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeviceSafetyButton } from '../../../chat/src/components/DeviceSafetyButton';

describe('Voice 统一设备入口', () => {
  it('复用设备安全面板且只声明 Voice 支持的设备', () => {
    render(
      <DeviceSafetyButton
        connected={false}
        deviceName={null}
        battery={null}
        onDisconnect={vi.fn()}
        limitA={30}
        limitB={30}
        onSetLimit={vi.fn()}
        sensor={null}
        opossum={null}
        onConnectDevice={vi.fn(async () => undefined)}
        onDisconnectOpossum={vi.fn()}
        supportedDeviceKinds={['coyote', 'opossum']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '设备与个人安全设置' }));
    expect(screen.getByText('设备与个人安全设置')).toBeTruthy();
    expect(screen.getByText(/自动识别Coyote 主机、Opossum 振动控制器/)).toBeTruthy();
    expect(screen.queryByText(/爪印传感器/)).toBeNull();
    expect(screen.queryByText(/灵猫边缘传感器/)).toBeNull();
    expect(screen.queryByRole('button', { name: /恢复默认波形/ })).toBeNull();
  });
});
