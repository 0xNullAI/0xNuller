import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ModuleSettingsProvider,
  ModuleSettingsSection,
  type ModuleSettingsClaim,
} from '@0xnullai/ui';
import { SettingsPanel } from './settings/SettingsPanel';
import type { AuthUser } from '@0xnullai/auth';
import productPackage from '../../../package.json';
import { loadProxy } from '@0xnullai/settings';

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

function renderSettings(
  user: AuthUser | null = null,
  initialTab?: 'ai-agent' | 'ai-voice' | 'ai-video',
) {
  render(
    <ModuleSettingsProvider>
      <SettingsPanel initialTab={initialTab} user={user} onUser={vi.fn()} onClose={vi.fn()} />
      <ModuleSettingsFixtures />
    </ModuleSettingsProvider>,
  );
}

describe('统一设置顺序', () => {
  beforeEach(() => localStorage.clear());

  it('按账户、通用、AI、波形、场景、设备安全、数据排列', async () => {
    renderSettings();
    const navigation = screen.getByRole('navigation');

    await screen.findByRole('button', { name: '波形' });
    expect(
      within(navigation)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['账户', '通用', 'AI', '波形', '场景', '设备安全', '数据', '关于']);
    expect(within(navigation).queryByRole('button', { name: '传感器' })).toBeNull();
  });

  it('把所有 AI 共用的网络代理放进通用设置', () => {
    renderSettings();
    expect(screen.getByText('AI 网络代理')).toBeTruthy();
    expect(screen.getByText('Agent、Voice 和 Video 共用此代理，无需分别设置。')).toBeTruthy();
    const enabled = screen.getByRole('checkbox', { name: 'AI 网络代理' });
    expect((enabled as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('反向代理地址'), {
      target: { value: 'https://proxy.example' },
    });
    expect((enabled as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(enabled);
    expect(loadProxy()).toEqual({ enabled: true, httpBaseUrl: 'https://proxy.example' });

    fireEvent.click(screen.getByRole('button', { name: 'AI' }));
    expect(screen.queryByText('AI 网络代理')).toBeNull();
  });

  it('模块入口可直接路由到对应 AI 子设置', () => {
    renderSettings(null, 'ai-video');
    expect(screen.getByRole('button', { name: 'AI' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('tab', { name: 'Video' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Video 视觉模型' })).toBeTruthy();
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
    ).toEqual(['账户', '管理', '通用', 'AI', '波形', '场景', '设备安全', '数据', '关于']);
  });

  it('在关于页显示统一产品版本和下载入口', async () => {
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: '关于' }));

    expect(screen.getByText(`v${productPackage.version}`)).toBeTruthy();
    expect(screen.getByText('通用设备（实验性）')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '启用通用设备' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '下载 Android 版' })).toBeTruthy();
  });
});
