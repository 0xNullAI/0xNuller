// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

vi.mock('@0xnullai/auth', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  avatarSrc: () => null,
  getCreditBalance: async () => ({ total: 0, reserved: 0, available: 0 }),
}));
vi.mock('./AccountContent', () => ({ AccountContent: () => <div>账户内容</div> }));
vi.mock('./AdminContent', () => ({ AdminContent: () => <div>管理内容</div> }));
vi.mock('./PersonalMemoryContent', () => ({ PersonalMemoryContent: () => <div>记忆内容</div> }));
vi.mock('./AiTab', () => ({ AiTab: () => <div>AI 内容</div> }));
vi.mock('./GeneralTab', () => ({ GeneralTab: () => <div>通用内容</div> }));
vi.mock('./AboutTab', () => ({ AboutTab: () => <div>关于内容</div> }));
vi.mock('./ScenesTab', () => ({ ScenesTab: () => <div>场景内容</div> }));

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

it('lists every page on one overview and folds rare pages into their owners', () => {
  render(<Harness />);
  const route = () => screen.getByRole('status', { name: '路由' }).textContent;

  const rows = screen
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((text) => /^(通用|设备与安全|角色与场景|AI|关于)/.test(text))
    .map((text) => text.match(/^(通用|设备与安全|角色与场景|AI|关于)/)![1]);
  // 通用 and 设备与安全 sit at the top, then 陪伴, then 关于.
  expect(rows).toEqual(['通用', '设备与安全', '角色与场景', 'AI', '关于']);
  // 通知 is inside 通用, 波形 inside 设备, 数据 inside 关于, 个人记忆 inside AI; 管理 is admin-only.
  for (const name of ['通知', '波形', '数据', '高级设置', '管理', '个人记忆'])
    expect(screen.queryByRole('button', { name })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /^角色与场景/ }));
  expect(route()).toBe('scenes');
  fireEvent.click(screen.getByRole('button', { name: '返回设置列表' }));
  expect(route()).toBe('overview');

  // 设备: the waveform library and 高级 are entries at the bottom; 高级 opens one flat sub-page
  // whose title and back arrow live in the panel header.
  fireEvent.click(screen.getByRole('button', { name: /^设备与安全/ }));
  expect(screen.getByRole('button', { name: '波形库' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '高级' }));
  expect(screen.getByRole('heading', { level: 2, name: '设备 · 高级' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: '返回上一页' })).toHaveLength(1);
  expect(document.querySelector('details')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '返回上一页' }));
  expect(route()).toBe('safety');
  expect(screen.getByRole('heading', { level: 2, name: '设备与安全' })).toBeTruthy();
});

it('sends retired page links to the page that now holds them', () => {
  for (const [initialTab, heading] of [
    ['advanced', '我的'],
    ['agent-data', '关于'],
    ['agent-waveforms', '设备与安全'],
    ['notifications', '通用'],
  ] as const) {
    render(
      <SettingsPanel
        initialTab={initialTab}
        onNavigateTab={() => undefined}
        user={null}
        onUser={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: heading })).toBeTruthy();
    cleanup();
  }
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
