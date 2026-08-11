import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminContent } from './AdminContent';
import { deleteItem, fetchAdminItems, setItemHidden } from '../../../market/src/web/api';

vi.mock('../../../market/src/web/api', () => ({
  deleteItem: vi.fn(),
  fetchAdminItems: vi.fn(),
  setItemHidden: vi.fn(),
}));

const ITEM = {
  id: 'item-1',
  type: 'waveform' as const,
  name: '测试波形',
  author: 'alice',
  tags: [],
  content: { frames: [[10, 0] as [number, number]] },
  downloads: 0,
  views: 0,
  createdAt: 1,
  hidden: false,
};

describe('管理员内容管理', () => {
  beforeEach(() => {
    vi.mocked(fetchAdminItems).mockResolvedValue({ items: [ITEM], nextOffset: null });
    vi.mocked(setItemHidden).mockResolvedValue();
    vi.mocked(deleteItem).mockResolvedValue();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
  });

  it('默认显示全部内容并可隐藏', async () => {
    render(<AdminContent />);
    expect(await screen.findByText('测试波形')).toBeTruthy();
    expect(fetchAdminItems).toHaveBeenCalledWith({
      status: 'all',
      q: undefined,
      offset: 0,
      limit: 20,
    });

    fireEvent.click(screen.getByRole('button', { name: '隐藏 测试波形' }));
    await vi.waitFor(() => expect(setItemHidden).toHaveBeenCalledWith('item-1', true));
  });

  it('删除前明确确认', async () => {
    render(<AdminContent />);
    await screen.findByText('测试波形');
    fireEvent.click(screen.getByRole('button', { name: '删除 测试波形' }));
    await vi.waitFor(() => expect(deleteItem).toHaveBeenCalledWith('item-1'));
    expect(window.confirm).toHaveBeenCalledWith('永久删除「测试波形」？');
  });
});
