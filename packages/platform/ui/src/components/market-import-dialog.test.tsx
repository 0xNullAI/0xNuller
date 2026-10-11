import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarketImportDialog } from './market-import-dialog';

const market = vi.hoisted(() => ({ fetch: vi.fn(), downloaded: vi.fn() }));
vi.mock('@0xnullai/market-client', () => ({
  fetchMarketItems: market.fetch,
  markMarketDownloaded: market.downloaded,
}));

const item = {
  id: 'valley',
  type: 'scenario' as const,
  name: '山谷',
  icon: '🌿',
  author: 'alice',
  downloads: 0,
  description: '',
  content: { prompt: '山谷规则' },
};

beforeEach(() => {
  vi.clearAllMocks();
  market.fetch.mockResolvedValue([item]);
  market.downloaded.mockResolvedValue(undefined);
});
afterEach(cleanup);

it('reports a failed online import without marking it downloaded and permits a retry', async () => {
  const importItem = vi
    .fn()
    .mockRejectedValueOnce(new Error('云端暂不可用'))
    .mockResolvedValueOnce(undefined);
  render(<MarketImportDialog open onOpenChange={vi.fn()} type="scenario" onImport={importItem} />);
  expect(screen.getByRole('heading', { name: '从市场导入角色或场景' })).toBeTruthy();
  const button = await screen.findByRole('button', { name: '导入' });
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '云端暂不可用');
  expect(market.downloaded).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '导入' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '已导入' })).toBeTruthy());
  expect(importItem).toHaveBeenCalledTimes(2);
  expect(market.downloaded).toHaveBeenCalledWith('valley');
});

it('does not label the next account imported when an old request completes', async () => {
  let finish!: () => void;
  const importItem = vi.fn().mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  render(<MarketImportDialog open onOpenChange={vi.fn()} type="scenario" onImport={importItem} />);
  fireEvent.click(await screen.findByRole('button', { name: '导入' }));
  window.dispatchEvent(new Event('0xnullai:auth-changed'));
  finish();
  await waitFor(() => expect(screen.getByRole('button', { name: '导入' })).toBeTruthy());
  expect(market.downloaded).not.toHaveBeenCalled();
});
