import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatSearchDialog } from './ChatSearchDialog';
afterEach(cleanup);
it('searches after typing, highlights matches and picks a message', async () => {
  const search = vi.fn(async () => [
    { id: 'm2', senderName: 'Bob', fromSelf: false, text: '低敏猫粮到了', timestamp: 2 },
    { id: 'm1', senderName: 'Alice', fromSelf: true, text: '猫粮快吃完了', timestamp: 1 },
  ]);
  const pick = vi.fn();
  render(<ChatSearchDialog onSearch={search} onPick={pick} onClose={() => {}} />);
  fireEvent.change(screen.getByRole('textbox', { name: '搜索聊天记录' }), {
    target: { value: ' 猫粮 ' },
  });
  const hit = await screen.findByRole('button', { name: /Bob.*低敏猫粮到了/ });
  expect(search).toHaveBeenCalledTimes(1);
  expect(search).toHaveBeenCalledWith('猫粮');
  expect(screen.getAllByText('猫粮', { selector: 'mark' })).toHaveLength(2);
  expect(screen.getByRole('button', { name: /^我/ })).toBeTruthy();
  fireEvent.click(hit);
  expect(pick).toHaveBeenCalledWith('m2');
});

it('shows an empty state and a failure message', async () => {
  const search = vi
    .fn<(query: string) => Promise<never[]>>()
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('搜索超时'));
  render(<ChatSearchDialog onSearch={search} onPick={() => {}} onClose={() => {}} />);
  const input = screen.getByRole('textbox', { name: '搜索聊天记录' });
  fireEvent.change(input, { target: { value: '不存在' } });
  expect(await screen.findByText('没有找到')).toBeTruthy();
  fireEvent.change(input, { target: { value: '再试' } });
  expect(await screen.findByText('搜索超时')).toBeTruthy();
});
