// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ItemDetail } from './ItemDetail';
import type { MarketItem } from '../../shared/schema';
const api = vi.hoisted(() => ({ update: vi.fn(), copy: vi.fn() }));
vi.mock('@0xnullai/ui', () => ({ Overlay: ({ children }: { children: ReactNode }) => children }));
vi.mock('../api', () => ({
  fetchItemAccess: async () => ({ canEdit: true, canDelete: false }),
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
it('copies the entire long script, including escapes and its final characters', async () => {
  render(createElement(ItemDetail, { item, onClose: () => {} }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制 JSON' })));
  expect(JSON.parse(api.copy.mock.calls[0]![0]).prompt).toBe(prompt);
  expect(screen.getByRole('button', { name: '已复制 ✓' })).toBeTruthy();
});
it('retains oversized editor text, rejects saving, and saves all text after correction', async () => {
  render(createElement(ItemDetail, { item, onClose: () => {} }));
  fireEvent.click(await screen.findByRole('button', { name: '✏️ 编辑' }));
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
      expect.objectContaining({ content: { prompt } }),
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
