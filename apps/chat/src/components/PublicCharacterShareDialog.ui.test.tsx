import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PublicCharacterShareDialog } from './PublicCharacterShareDialog';
vi.mock('@0xnullai/market-client', () => ({
  marketBaseUrl: () => '',
  fetchMarketItems: async () => [
    {
      id: 'public-one',
      name: '公开伙伴',
      type: 'scenario',
      content: { prompt: '公开人设' },
      tags: [],
    },
  ],
}));
afterEach(cleanup);
it('requires a selected card and explicit send; rejected sending keeps the preview', async () => {
  const send = vi.fn(() => false);
  const close = vi.fn();
  render(<PublicCharacterShareDialog onSend={send} onClose={close} />);
  expect(
    (screen.getByRole('button', { name: '发送到当前聊天' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(await screen.findByRole('button', { name: /公开伙伴/ }));
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '发送到当前聊天' }));
  expect(send).toHaveBeenCalledWith('公开角色卡：公开伙伴\n/market?item=public-one');
  expect(close).not.toHaveBeenCalled();
});
