import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ModuleSettingsProvider,
  ModuleSettingsSection,
  type ModuleSettingsClaim,
} from '@0xnullai/ui';
import { SettingsPanel } from './settings/SettingsPanel';
import type { AuthUser } from '@0xnullai/auth';

function ModuleSettingsFixtures() {
  const claims: Array<ModuleSettingsClaim & { content: string; navigation?: boolean }> = [
    { id: 'agent-waveforms', label: '波形', order: 30, content: '波形内容' },
    {
      id: 'agent-sensors',
      label: '传感器',
      order: 45,
      content: '传感器内容',
      navigation: false,
    },
    { id: 'agent-data', label: '数据', order: 60, content: '数据内容' },
  ];

  return claims.map((claim) => (
    <ModuleSettingsSection
      key={claim.id}
      id={claim.id}
      label={claim.label}
      order={claim.order}
      navigation={claim.navigation}
    >
      <div>{claim.content}</div>
    </ModuleSettingsSection>
  ));
}

function renderSettings(user: AuthUser | null = null) {
  render(
    <ModuleSettingsProvider>
      <SettingsPanel user={user} onUser={vi.fn()} onClose={vi.fn()} />
      <ModuleSettingsFixtures />
    </ModuleSettingsProvider>,
  );
}

describe('统一设置顺序', () => {
  it('按账户、外观、AI、波形、场景、设备安全、数据排列', async () => {
    renderSettings();
    const navigation = screen.getByRole('navigation');

    await screen.findByRole('button', { name: '波形' });
    expect(
      within(navigation)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['账户', '外观', 'AI', '波形', '场景', '设备安全', '数据']);
    expect(within(navigation).queryByRole('button', { name: '传感器' })).toBeNull();
  });

  it('把传感器配置放进设备安全页', async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: '设备安全' }));
    expect(await screen.findByText('传感器内容')).toBeTruthy();
  });

  it('管理页仅向管理员账户显示', async () => {
    renderSettings({ id: 'admin-1', username: 'admin', displayName: 'Admin', role: 'admin' });
    const navigation = screen.getByRole('navigation');
    await screen.findByRole('button', { name: '波形' });
    expect(
      within(navigation)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['账户', '管理', '外观', 'AI', '波形', '场景', '设备安全', '数据']);
  });
});
