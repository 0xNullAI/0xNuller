// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
const api = vi.hoisted(() => ({
  fetch: vi.fn(),
  access: vi.fn(),
  list: vi.fn(),
  discovery: vi.fn(),
  feedback: vi.fn(),
}));
const shell = vi.hoisted(() => ({ signedIn: true, openSettings: vi.fn() }));
const account = vi.hoisted(() => ({ id: 'alice' as string | null }));
vi.mock('@0xnullai/auth', () => ({
  me: async () => (account.id ? { id: account.id, role: 'user' } : null),
  currentAuthUserId: () => account.id,
  subscribeAuthChanges: () => () => {},
}));
vi.mock('./api', () => ({
  fetchBrowsePage: api.list,
  fetchItem: api.fetch,
  fetchItemAccess: api.access,
  fetchDiscovery: api.discovery,
  fetchFollowedCreators: vi.fn().mockResolvedValue({ accountId: 'alice', creators: [] }),
  saveCreatorFollow: vi.fn(),
  markViewed: vi.fn(),
  recordCharacterDetailOpen: vi.fn().mockResolvedValue({ recorded: true }),
  listDiscoveryFeedback: api.feedback,
  saveDiscoveryFeedback: vi.fn(),
  deleteDiscoveryFeedback: vi.fn(),
}));
vi.mock('./components/ItemCard', () => ({ ItemCard: () => null }));
vi.mock('./components/UploadDialog', () => ({ UploadDialog: () => null }));
vi.mock('./components/CharacterStudio', () => ({
  CharacterStudio: ({ item, onClose }: { item?: { name: string }; onClose: () => void }) =>
    createElement(
      'main',
      { 'aria-label': item ? '编辑公开角色与场景' : '创建公开角色与场景' },
      item?.name ?? '新角色',
      createElement('button', { onClick: onClose }, '返回发现'),
    ),
}));
vi.mock('./components/ItemDetail', () => ({
  ItemDetail: ({ item }: { item: { name: string } }) =>
    createElement('div', { role: 'dialog' }, item.name),
}));
vi.mock('@0xnullai/ui', () => ({
  Button: 'button',
  useInShell: () => true,
  useShellNav: () => null,
  useOpenShellSettings: () => shell.openSettings,
  useShellSignedIn: () => shell.signedIn,
}));
beforeEach(() => {
  shell.signedIn = true;
  account.id = 'alice';
  api.list.mockResolvedValue({ items: [], nextCursor: null, pagination: 'stable' });
  api.discovery.mockResolvedValue([]);
  api.feedback.mockResolvedValue([]);
  api.access.mockResolvedValue({ canEdit: true, canDelete: true });
});
const chooseScope = (name: '全部' | '我的收藏' | '关注作者') => {
  if (!screen.queryByRole('region', { name: '内容筛选' }))
    fireEvent.click(screen.getByRole('button', { name: /筛选/ }));
  fireEvent.click(screen.getByRole('button', { name }));
};
it('未登录时个性化发现显示账户入口且不请求私人列表', async () => {
  shell.signedIn = false;
  render(createElement(App));
  chooseScope('我的收藏');
  expect(await screen.findByText('登录后继续发现')).toBeTruthy();
  expect(api.discovery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '登录 / 注册' }));
  expect(shell.openSettings).toHaveBeenCalledWith('account');
  chooseScope('关注作者');
  expect(screen.queryByText(/管理已关注作者/)).toBeNull();
  expect(api.discovery).not.toHaveBeenCalled();
});
it('只有一排分类；收藏和关注作者放在筛选里，选中后显示可清除的范围', async () => {
  render(createElement(App));
  expect(screen.queryByRole('navigation', { name: '发现方式' })).toBeNull();
  expect(screen.getByRole('navigation', { name: '内容分类' }).children).toHaveLength(3);
  expect(screen.getByRole('button', { name: '筛选' }).getAttribute('aria-expanded')).toBe('false');
  chooseScope('关注作者');
  expect(screen.getByRole('navigation', { name: '内容分类' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: '搜索公开内容' })).toBeNull();
  await waitFor(() =>
    expect(api.discovery).toHaveBeenCalledWith('following', 'character', 'scenario'),
  );
  expect(await screen.findByText('还没有关注作者的内容')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /正在查看关注作者/ }));
  expect(screen.getByRole('textbox', { name: '搜索公开内容' })).toBeTruthy();
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.clearAllMocks();
});
it('角色、场景和波形使用同一分类行，筛选面板显示当前选中项', async () => {
  render(createElement(App));
  expect(screen.getByRole('navigation', { name: '内容分类' }).children).toHaveLength(3);
  await waitFor(() =>
    expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scenario', kind: 'character' }),
    ),
  );
  expect(screen.getByRole('button', { name: '角色' }).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('button', { name: '多人场景' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '场景' }));
  await waitFor(() =>
    expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scenario', kind: 'scene' }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '筛选' }));
  expect(screen.getByRole('region', { name: '内容筛选' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '最新发布' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: '热门内容' }));
  expect(screen.getByRole('button', { name: '热门内容' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  await waitFor(() =>
    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ sort: 'hot', kind: 'scene' })),
  );
  fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
  expect(screen.getByRole('button', { name: '最新发布' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('region', { name: '内容筛选' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '波形' }));
  fireEvent.click(screen.getByRole('button', { name: '筛选' }));
  expect(screen.getByRole('group', { name: '波形类型' })).toBeTruthy();
  await waitFor(() =>
    expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'waveform', modality: 'electrostimulation' }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '震动波形' }));
  await waitFor(() =>
    expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'waveform', modality: 'vibration' }),
    ),
  );
  expect(screen.getByLabelText('已选 1 项筛选')).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('region', { name: '内容筛选' })).toBeNull();
});

it('键盘或关闭按钮收起筛选后，将焦点还给筛选入口', () => {
  render(createElement(App));
  const trigger = screen.getByRole('button', { name: '筛选' });
  fireEvent.click(trigger);
  screen.getByRole('button', { name: '热门内容' }).focus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('region', { name: '内容筛选' })).toBeNull();
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);
  screen.getByRole('button', { name: '关闭筛选' }).focus();
  fireEvent.click(screen.getByRole('button', { name: '关闭筛选' }));
  expect(screen.queryByRole('region', { name: '内容筛选' })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('opens the linked public item independently of the first list page', async () => {
  window.history.replaceState({}, '', '/market?item=card-20');
  api.fetch.mockResolvedValue({ id: 'card-20', name: '公开伙伴' });
  render(createElement(App));
  expect((await screen.findByRole('dialog')).textContent).toBe('公开伙伴');
  expect(api.fetch).toHaveBeenCalledWith('card-20');
});
it('shows a removed or unavailable item explicitly', async () => {
  window.history.replaceState({}, '', '/market?item=removed');
  api.fetch.mockRejectedValue(new Error('not found'));
  render(createElement(App));
  expect((await screen.findByRole('alert')).textContent).toContain('已下架');
});

it('restores a scene editor from its URL and returns to discovery', async () => {
  window.history.replaceState({}, '', '/market?editor=new&kind=scene');
  render(createElement(App));
  expect(await screen.findByRole('main', { name: '创建公开角色与场景' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回发现' }));
  expect(window.location.search).toBe('');
  expect(screen.queryByRole('main', { name: '创建公开角色与场景' })).toBeNull();
});

it('requires verified owner access before restoring a published editor URL', async () => {
  window.history.replaceState({}, '', '/market?editor=card-20');
  api.fetch.mockResolvedValue({
    id: 'card-20',
    name: '公开伙伴',
    type: 'scenario',
    content: { prompt: '人设', characterCard: {} },
  });
  api.access.mockResolvedValueOnce({ canEdit: false, canDelete: false });
  render(createElement(App));
  expect((await screen.findByRole('alert')).textContent).toContain('无权编辑');
  expect(screen.queryByRole('main', { name: '编辑公开角色与场景' })).toBeNull();
  expect(api.access).toHaveBeenCalledWith('card-20');
});

it('opens an old prompt-only scene in the unified editor after refresh', async () => {
  window.history.replaceState({}, '', '/market?editor=card-20');
  api.fetch.mockResolvedValue({
    id: 'card-20',
    name: '公开伙伴',
    type: 'scenario',
    content: { prompt: '旧场景设定' },
  });
  render(createElement(App));
  expect((await screen.findByRole('main', { name: '编辑公开角色与场景' })).textContent).toContain(
    '公开伙伴',
  );
  window.history.replaceState({}, '', '/market');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await waitFor(() =>
    expect(screen.queryByRole('main', { name: '编辑公开角色与场景' })).toBeNull(),
  );
});

it('发现页不显示内置起点，创建入口固定在分类行', async () => {
  api.list.mockResolvedValue([
    {
      id: 'real-card',
      type: 'scenario',
      name: '真实公开角色',
      content: { kind: 'character', prompt: '人设' },
      tags: [],
    },
  ]);
  render(createElement(App));
  await waitFor(() => expect(api.list).toHaveBeenCalled());
  expect(screen.queryByText(/精选原创角色起点/)).toBeNull();
  expect(screen.queryByRole('button', { name: '多人场景' })).toBeNull();
  const categoryRow = screen.getByRole('navigation', { name: '内容分类' }).parentElement;
  expect(categoryRow?.lastElementChild?.textContent).toContain('创建');
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  expect(screen.getByRole('group', { name: '创建内容' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '创建场景' }));
  expect(await screen.findByRole('main', { name: '创建公开角色与场景' })).toBeTruthy();
  expect(window.location.search).toContain('kind=scene');
});
it('未登录创建进入账户设置，不打开编辑器', async () => {
  shell.signedIn = false;
  account.id = null;
  render(createElement(App));
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  fireEvent.click(screen.getByRole('button', { name: '创建角色' }));
  expect(shell.openSettings).toHaveBeenCalledWith('account');
  expect(screen.queryByRole('main', { name: '创建公开角色与场景' })).toBeNull();
});
