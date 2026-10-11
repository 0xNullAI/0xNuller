// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

vi.mock('@0xnullai/auth', () => ({ avatarSrc: () => null }));
vi.mock('./AccountContent', () => ({ AccountContent: () => <div>账户内容</div> }));
vi.mock('./AdminContent', () => ({ AdminContent: () => <div>管理内容</div> }));
vi.mock('./NotificationsTab', () => ({ NotificationsTab: () => <div>通知内容</div> }));
vi.mock('./PersonalMemoryContent', () => ({ PersonalMemoryContent: () => <div>记忆内容</div> }));
vi.mock('./AiTab', () => ({ AiTab: () => <div>AI 内容</div> }));
vi.mock('./GeneralTab', () => ({ GeneralTab: () => <div>通用内容</div> }));
vi.mock('./AboutTab', () => ({ AboutTab: () => <div>关于内容</div> }));
vi.mock('./ScenesTab', () => ({ ScenesTab: () => <div>场景内容</div> }));
vi.mock('./ExperimentalDeviceSection', () => ({
  ExperimentalDeviceSection: () => <section aria-label="通用设备（实验性）" />,
}));

afterEach(cleanup);

function Harness() {
  const [tab, setTab] = useState('overview');
  return (
    <>
      <output aria-label="路由">{tab}</output>
      <SettingsPanel
        initialTab={tab}
        onNavigateTab={setTab}
        user={null}
        onUser={() => undefined}
        onClose={() => undefined}
      />
    </>
  );
}

it('keeps rarely used pages behind 高级设置 and opens a page 高级 under the panel header', () => {
  render(<Harness />);
  const route = () => screen.getByRole('status', { name: '路由' }).textContent;

  for (const name of ['AI', '设备安全', '通知', '通用', '关于', '高级设置'])
    expect(screen.getByRole('button', { name })).toBeTruthy();
  for (const name of ['个人记忆', '场景', '波形', '数据'])
    expect(screen.queryByRole('button', { name })).toBeNull();
  expect(screen.queryByRole('region', { name: 'AI 网络代理' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '高级设置' }));
  expect(route()).toBe('advanced');
  expect(screen.getByRole('heading', { name: '高级设置' })).toBeTruthy();
  for (const name of ['个人记忆', '场景', '波形', '数据'])
    expect(screen.getByRole('button', { name })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'AI 网络代理' })).toBeTruthy();
  expect(screen.getByRole('region', { name: '通用设备（实验性）' })).toBeTruthy();

  // An advanced page keeps its own route and returns to 高级设置.
  fireEvent.click(screen.getByRole('button', { name: '场景' }));
  expect(route()).toBe('scenes');
  fireEvent.click(screen.getByRole('button', { name: '返回高级设置' }));
  expect(route()).toBe('advanced');
  fireEvent.click(screen.getByRole('button', { name: '返回设置列表' }));
  expect(route()).toBe('overview');

  // A page's 高级 row opens one flat sub-page; the panel header owns its title and back.
  fireEvent.click(screen.getByRole('button', { name: '设备安全' }));
  fireEvent.click(screen.getByRole('button', { name: '高级' }));
  expect(screen.getByRole('heading', { level: 2, name: '设备安全 · 高级' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: '返回上一页' })).toHaveLength(1);
  expect(document.querySelector('details')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '返回上一页' }));
  expect(route()).toBe('safety');
  expect(screen.getByRole('heading', { level: 2, name: '设备安全' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '高级' })).toBeTruthy();
});

it('keeps the open chat’s settings out of 我的 and returns to the chat from them', async () => {
  const { ModuleSettingsProvider, ModuleSettingsSection } = await import('@0xnullai/ui');
  const onClose = vi.fn();
  const view = (initialTab: string) => (
    <ModuleSettingsProvider>
      <ModuleSettingsSection id="agent-companion" label="聊天设置">
        <p>本聊天内容</p>
      </ModuleSettingsSection>
      <SettingsPanel
        initialTab={initialTab}
        onNavigateTab={() => undefined}
        user={null}
        onUser={() => undefined}
        onClose={onClose}
      />
    </ModuleSettingsProvider>
  );
  const { rerender } = render(view('overview'));
  expect(screen.queryByRole('button', { name: '聊天设置' })).toBeNull();
  rerender(view('agent-companion'));
  fireEvent.click(await screen.findByRole('button', { name: '返回聊天' }));
  expect(onClose).toHaveBeenCalledOnce();
});
