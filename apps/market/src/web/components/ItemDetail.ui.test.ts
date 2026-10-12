// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ItemDetail } from './ItemDetail';
import type { MarketItem } from '../../shared/schema';
vi.mock('./FavoriteAction', () => ({ FavoriteAction: () => null }));
vi.mock('./CharacterReports', () => ({ CharacterReportAction: () => 'report-form' }));
const api = vi.hoisted(() => ({ update: vi.fn(), copy: vi.fn() }));
vi.mock('@0xnullai/ui', () => ({
  Button: 'button',
  Overlay: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../api', () => ({
  fetchItemAccess: async () => ({ canEdit: true, canDelete: false }),
  fetchCreatorFollow: async () => ({ creator: null, followed: false, accountId: 'user' }),
  saveCreatorFollow: vi.fn(),
  updateItem: api.update,
  markDownloaded: async () => {},
  deleteItem: vi.fn(),
}));
const prompt = ' \n' + '中😀"\\\n'.repeat(12000) + '结尾必须保留\n ';
const item: MarketItem = {
  id: 'test',
  type: 'scenario',
  name: '长剧本',
  tags: [],
  content: { prompt },
  downloads: 0,
  views: 0,
  createdAt: 0,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { clipboard: { writeText: api.copy } });
  api.copy.mockResolvedValue(undefined);
  api.update.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
// Secondary actions live in the ⋯ menu.
async function openMenuItem(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  return screen.findByRole('menuitem', { name });
}
it('copies the entire long script, including escapes and its final characters', async () => {
  render(createElement(ItemDetail, { item, onClose: () => {} }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制 JSON' })));
  expect(JSON.parse(api.copy.mock.calls[0]![0]).prompt).toBe(prompt);
  expect(screen.getByRole('button', { name: '已复制 ✓' })).toBeTruthy();
});
it('retains oversized editor text, rejects saving, and saves all text after correction', async () => {
  render(createElement(ItemDetail, { item, onClose: () => {} }));
  fireEvent.click(await openMenuItem('编辑'));
  const input = screen.getByRole('textbox', { name: /剧本内容/ }) as HTMLTextAreaElement;
  expect(input.hasAttribute('maxlength')).toBe(false);
  const oversized = '界'.repeat(100000) + '末尾';
  fireEvent.change(input, { target: { value: oversized } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(input.value).toBe(oversized);
  expect(screen.getByRole('alert').textContent).toContain('内容已完整保留');
  expect(api.update).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: prompt } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() =>
    expect(api.update).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ content: { prompt, kind: 'scene' } }),
    ),
  );
});
it('reports a clipboard failure instead of claiming the copy succeeded', async () => {
  api.copy.mockRejectedValue(new Error('permission denied'));
  render(createElement(ItemDetail, { item, onClose: () => {} }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制 JSON' })));
  expect(screen.getByRole('alert').textContent).toContain('复制失败');
  expect(screen.queryByRole('button', { name: '已复制 ✓' })).toBeNull();
});
it('保留角色卡导出，并允许所有者修改结构化人物设定', async () => {
  const characterCard = {
    schemaVersion: 1 as const,
    description: '背景',
    personality: '安静',
    greeting: '你好',
    exampleDialogue: '示例',
    tags: ['陪伴'],
    creator: '作者',
    license: 'MIT',
  };
  render(
    createElement(ItemDetail, {
      item: { ...item, content: { prompt: '原始剧本', characterCard } },
      onClose: () => {},
    }),
  );
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制 JSON' })));
  expect(JSON.parse(api.copy.mock.calls[0]![0]).characterCard).toEqual(characterCard);
  fireEvent.click(await openMenuItem('编辑'));
  fireEvent.change(screen.getByRole('textbox', { name: /性格与表达方式/ }), {
    target: { value: '幽默而细心' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() =>
    expect(api.update).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({
        content: {
          prompt: '原始剧本',
          kind: 'character',
          characterCard: { ...characterCard, personality: '幽默而细心' },
        },
      }),
    ),
  );
});

it('starts a relationship only for a character; a scene has no chat entity', async () => {
  const start = vi.fn().mockResolvedValue(undefined);
  const characterCard = {
    schemaVersion: 1 as const,
    description: '',
    personality: '',
    greeting: '',
    exampleDialogue: '',
    tags: [],
    creator: '',
    license: '',
  };
  const character = { ...item, content: { prompt: '人物设定', characterCard } };
  const view = render(
    createElement(ItemDetail, { item: character, onClose: () => {}, onStartCharacter: start }),
  );
  fireEvent.click(screen.getByRole('button', { name: '开始聊天' }));
  await waitFor(() => expect(start).toHaveBeenCalledWith(character));
  view.rerender(createElement(ItemDetail, { item, onClose: () => {}, onStartCharacter: start }));
  expect(screen.queryByRole('button', { name: '开始聊天' })).toBeNull();
  expect(screen.getByText(/不是角色，也没有记忆/)).toBeTruthy();
});

it('offers a scene import without presenting it as a chat character', async () => {
  const importScene = vi.fn().mockResolvedValue(undefined);
  render(createElement(ItemDetail, { item, onClose: () => {}, onImportScene: importScene }));
  expect(screen.queryByRole('button', { name: '开始聊天' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '导入场景' }));
  await waitFor(() => expect(importScene).toHaveBeenCalledWith(item));
  expect(screen.getByRole('button', { name: '已导入场景' })).toBeTruthy();
});

it('updates the visible export when the full detail arrives after a list card', async () => {
  const first = { ...item, content: { prompt: '人物设定' } };
  const full = {
    ...first,
    content: {
      prompt: '人物设定',
      sourceArchive: {
        format: 'ccv2' as const,
        raw: { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '书屋' } },
      },
    },
  };
  const view = render(createElement(ItemDetail, { item: first, onClose: () => {} }));
  view.rerender(createElement(ItemDetail, { item: full, onClose: () => {} }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制 JSON' })));
  expect(JSON.parse(api.copy.mock.calls[0]![0]).sourceArchive).toEqual(full.content.sourceArchive);
});

it('keeps secondary actions in the ⋯ menu and closes it on Escape without closing the screen', async () => {
  const onClose = vi.fn();
  render(createElement(ItemDetail, { item, onClose }));
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(await openMenuItem('举报'));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByText('report-form')).toBeTruthy();
  const download = await openMenuItem('下载 .json');
  fireEvent.keyDown(download, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});
