import { expect, it, vi } from 'vitest';
import type { PrivateConversationChannel } from '@0xnullai/auth';
import { VoiceConversationHistory } from './voice-history';
it('persists only final subtitle text and reuses identity on retries after failure', async () => {
  const append = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
  const channel = { append, dispose: vi.fn() } as unknown as PrivateConversationChannel;
  const history = new VoiceConversationHistory(channel, 'call1');
  await history.record({ id: 'provider-item', role: 'user', text: '还在说', done: false });
  expect(append).not.toHaveBeenCalled();
  const final = { id: 'provider-item', role: 'user' as const, text: '这是最终字幕', done: true };
  await expect(history.record(final)).rejects.toThrow('offline');
  expect(history.hasUnsaved).toBe(true);
  await history.retry();
  expect(history.hasUnsaved).toBe(false);
  expect(append.mock.calls[0]).toEqual(append.mock.calls[1]);
  expect(Object.keys(append.mock.calls[1]![0][0]).sort()).toEqual([
    'content',
    'createdAt',
    'id',
    'role',
  ]);
  await history.record(final);
  expect(append).toHaveBeenCalledTimes(2);
  await expect(history.record({ ...final, text: '另一份最终字幕' })).rejects.toThrow('冲突');
});
it('isolates provider item IDs between calls', async () => {
  const append = vi.fn().mockResolvedValue({});
  const channel = { append } as unknown as PrivateConversationChannel;
  const entry = { id: 'same-id', role: 'assistant' as const, text: '你好', done: true };
  await new VoiceConversationHistory(channel, 'one').record(entry);
  await new VoiceConversationHistory(channel, 'two').record(entry);
  expect(append.mock.calls[0]![0][0].id).not.toBe(append.mock.calls[1]![0][0].id);
});
it('coalesces duplicate final events and a simultaneous retry into one server append', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const append = vi.fn().mockReturnValue(pending);
  const channel = { append } as unknown as PrivateConversationChannel;
  const history = new VoiceConversationHistory(channel, 'one-call');
  const final = { id: 'one-item', role: 'user' as const, text: '最终字幕', done: true };
  const writes = [history.record(final), history.record(final), history.retry()];
  expect(history.hasUnsaved).toBe(true);
  await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
  finish();
  await Promise.all(writes);
  expect(history.hasUnsaved).toBe(false);
  await history.retry();
  expect(append).toHaveBeenCalledOnce();
});

it('keeps final subtitles in speaking order when an earlier server write fails', async () => {
  const append = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
  const channel = { append, dispose: vi.fn() } as unknown as PrivateConversationChannel;
  const history = new VoiceConversationHistory(channel, 'ordered-call');
  const user = { id: 'user-turn', role: 'user' as const, text: '先说的话', done: true };
  const assistant = {
    id: 'assistant-turn',
    role: 'assistant' as const,
    text: '后说的话',
    done: true,
  };

  const first = history.record(user);
  const second = history.record(assistant);
  await expect(first).rejects.toThrow('offline');
  await expect(second).rejects.toThrow('前一条字幕尚未保存');
  expect(append).toHaveBeenCalledTimes(1);

  await history.retry();
  expect(append.mock.calls.map(([messages]) => messages[0].content)).toEqual([
    '先说的话',
    '先说的话',
    '后说的话',
  ]);
  await history.retry();
  expect(append).toHaveBeenCalledTimes(3);
});

it('does not start a queued subtitle write after the call history is disposed', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const append = vi.fn().mockReturnValue(pending);
  const channel = { append, dispose: vi.fn() } as unknown as PrivateConversationChannel;
  const history = new VoiceConversationHistory(channel, 'disposed-call');
  const first = history.record({ id: 'first', role: 'user', text: '第一条', done: true });
  const second = history.record({ id: 'second', role: 'assistant', text: '第二条', done: true });
  await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
  history.dispose();
  finish();
  await first;
  await expect(second).rejects.toThrow('通话已结束');
  expect(append).toHaveBeenCalledOnce();
});
