import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonalMemoryContent } from './PersonalMemoryContent';
import {
  deletePersonalMemory,
  exportPersonalMemories,
  listPersonalMemories,
  savePersonalMemory,
  currentAuthUserId,
  subscribeAuthChanges,
} from '@0xnullai/auth';

let authAccount = 'alice';
const authListeners = new Set<Parameters<typeof subscribeAuthChanges>[0]>();

vi.mock('@0xnullai/auth', () => ({
  listPersonalMemories: vi.fn(),
  savePersonalMemory: vi.fn(),
  deletePersonalMemory: vi.fn(),
  exportPersonalMemories: vi.fn(),
  currentAuthUserId: vi.fn(() => authAccount),
  subscribeAuthChanges: vi.fn((listener) => {
    authListeners.add(listener);
    return () => {
      authListeners.delete(listener);
    };
  }),
}));
const memory = {
  id: 'm1',
  kind: 'person' as const,
  title: '小林',
  content: '周五面试',
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};
beforeEach(() => {
  vi.resetAllMocks();
  authAccount = 'alice';
  authListeners.clear();
  vi.mocked(currentAuthUserId).mockImplementation(() => authAccount);
  vi.mocked(subscribeAuthChanges).mockImplementation((listener) => {
    authListeners.add(listener);
    return () => {
      authListeners.delete(listener);
    };
  });
  vi.mocked(listPersonalMemories).mockResolvedValue({ items: [memory], limit: 200 });
});

it('offers no sharing into human chats', async () => {
  render(<PersonalMemoryContent />);
  await screen.findByText('小林');
  expect(screen.queryByRole('button', { name: '聊天中的共享' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^小林/ }));
  expect(screen.queryByText('共享到真人聊天')).toBeNull();
});
afterEach(cleanup);

it('clears old account content and ignores delayed A→B→A responses', async () => {
  const resolvers: ((value: { items: (typeof memory)[]; limit: number }) => void)[] = [];
  vi.mocked(listPersonalMemories).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  );
  render(<PersonalMemoryContent />);
  await waitFor(() => expect(resolvers).toHaveLength(1));
  await act(async () => {
    authAccount = 'bob';
    for (const listener of authListeners) listener({ id: 'bob' } as never);
  });
  await waitFor(() => expect(resolvers).toHaveLength(2));
  await act(async () => {
    authAccount = 'alice';
    for (const listener of authListeners) listener({ id: 'alice' } as never);
  });
  await waitFor(() => expect(resolvers).toHaveLength(3));
  await act(async () => {
    resolvers[0]!({ items: [{ ...memory, title: '旧 A' }], limit: 200 });
    resolvers[1]!({ items: [{ ...memory, title: '旧 B' }], limit: 200 });
  });
  expect(screen.queryByText('旧 A')).toBeNull();
  expect(screen.queryByText('旧 B')).toBeNull();
  await act(async () => {
    resolvers[2]!({ items: [{ ...memory, title: '新 A' }], limit: 200 });
  });
  expect(await screen.findByText('新 A')).toBeTruthy();
});

it('ignores a late save after A→B→A and unlocks the new account editor', async () => {
  let finishOldSave!: (value: { item: typeof memory }) => void;
  vi.mocked(savePersonalMemory)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldSave = resolve;
        }),
    )
    .mockResolvedValueOnce({ item: { ...memory, id: 'new', title: '新账号记忆' } });
  render(<PersonalMemoryContent />);
  fireEvent.click(await screen.findByRole('button', { name: /^小林/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(finishOldSave).toBeTypeOf('function'));
  await act(async () => {
    authAccount = 'bob';
    for (const listener of authListeners) listener({ id: 'bob' } as never);
    authAccount = 'alice';
    for (const listener of authListeners) listener({ id: 'alice' } as never);
  });
  fireEvent.click(await screen.findByRole('button', { name: '添加' }));
  await act(async () => {
    finishOldSave({ item: { ...memory, title: '旧账号写回' } });
  });
  expect(screen.queryByText('旧账号写回')).toBeNull();
  expect(screen.queryByText('已保存')).toBeNull();
  fireEvent.change(screen.getByLabelText('记忆标题'), { target: { value: '新账号记忆' } });
  fireEvent.change(screen.getByLabelText('记忆内容'), { target: { value: '只属于当前登录周期' } });
  fireEvent.click(screen.getByRole('button', { name: '添加记忆' }));
  await screen.findByText('新账号记忆');
  expect(savePersonalMemory).toHaveBeenCalledTimes(2);
});

it('edits and deletes server memories using their current version', async () => {
  vi.mocked(savePersonalMemory).mockResolvedValue({
    item: { ...memory, content: '改到周六', version: 2 },
  });
  vi.mocked(deletePersonalMemory).mockResolvedValue({ ok: true });
  render(<PersonalMemoryContent />);
  fireEvent.click(await screen.findByRole('button', { name: /^小林/ }));
  fireEvent.change(screen.getByLabelText('记忆内容'), { target: { value: '改到周六' } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await screen.findByText('改到周六');
  expect(savePersonalMemory).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'm1', version: 1, content: '改到周六' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: /^小林/ }));
  fireEvent.click(screen.getByRole('button', { name: '删除这条记忆' }));
  // Deleting asks once more before the memory is gone.
  expect(deletePersonalMemory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await screen.findByText('还没有个人记忆。');
  expect(deletePersonalMemory).toHaveBeenCalledWith('m1', 2);
});

it('keeps unsaved edits visible when the server rejects a conflict', async () => {
  vi.mocked(savePersonalMemory).mockRejectedValue(new Error('记忆已变更，请刷新后重试'));
  render(<PersonalMemoryContent />);
  fireEvent.click(await screen.findByRole('button', { name: /^小林/ }));
  fireEvent.change(screen.getByLabelText('记忆内容'), { target: { value: '我自己的修改' } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('记忆内容') as HTMLTextAreaElement).value).toBe('我自己的修改');
  expect(screen.queryByText('已保存')).toBeNull();
});

it('does not render stale results after the account panel has unmounted', async () => {
  let finish!: (value: { items: (typeof memory)[]; limit: number }) => void;
  vi.mocked(listPersonalMemories).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<PersonalMemoryContent />);
  view.unmount();
  finish({ items: [memory], limit: 200 });
  await waitFor(() => expect(screen.queryByText('小林')).toBeNull());
});

it('locks editing while rereading after a version conflict', async () => {
  vi.mocked(savePersonalMemory).mockRejectedValue(new Error('记忆已变更'));
  render(<PersonalMemoryContent />);
  fireEvent.click(await screen.findByRole('button', { name: /^小林/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await screen.findByRole('alert');
  let finish!: (value: { items: (typeof memory)[]; limit: number }) => void;
  vi.mocked(listPersonalMemories).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
  expect(screen.queryByRole('button', { name: '删除 小林' })).toBeNull();
  expect(screen.queryByRole('button', { name: '添加记忆' })).toBeNull();
  finish({ items: [], limit: 200 });
  await screen.findByText('还没有个人记忆。');
});

it('reuses the creation id when retrying a failed save', async () => {
  vi.mocked(listPersonalMemories).mockResolvedValue({ items: [], limit: 200 });
  vi.mocked(savePersonalMemory).mockRejectedValue(new Error('连接中断'));
  render(<PersonalMemoryContent />);
  fireEvent.click(await screen.findByRole('button', { name: '添加第一条' }));
  fireEvent.change(screen.getByLabelText('记忆标题'), { target: { value: '称呼' } });
  fireEvent.change(screen.getByLabelText('记忆内容'), { target: { value: '阿辰' } });
  fireEvent.click(screen.getByRole('button', { name: '添加记忆' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '添加记忆' }));
  await waitFor(() => expect(savePersonalMemory).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(savePersonalMemory).mock.calls;
  expect(calls[0]![0].id).toBe(calls[1]![0].id);
});

it('downloads the server export of every memory', async () => {
  vi.mocked(exportPersonalMemories).mockResolvedValue({
    format: '0xnuller-memories',
    memories: [],
  });
  const createObjectURL = vi.fn(() => 'blob:memories');
  const revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<PersonalMemoryContent />);
  await screen.findByText('小林');
  fireEvent.click(screen.getByRole('button', { name: '导出全部记忆' }));
  await screen.findByText('已导出全部记忆');
  expect(exportPersonalMemories).toHaveBeenCalledOnce();
  expect(click).toHaveBeenCalledOnce();
  const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
  expect(JSON.parse(await blob.text())).toEqual({ format: '0xnuller-memories', memories: [] });
  click.mockRestore();
});

it('groups memories by type and filters them by text', async () => {
  vi.mocked(listPersonalMemories).mockResolvedValue({
    items: [
      memory,
      { ...memory, id: 'm2', kind: 'preference', title: '称呼', content: '叫我阿城' },
    ],
    limit: 200,
  });
  render(<PersonalMemoryContent />);
  await screen.findByText('称呼');
  expect(screen.getByRole('region', { name: '重要的人' })).toBeTruthy();
  expect(screen.getByRole('region', { name: '我的偏好' })).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索记忆' }), {
    target: { value: '面试' },
  });
  expect(screen.getByText('小林')).toBeTruthy();
  expect(screen.queryByText('称呼')).toBeNull();
  expect(screen.queryByRole('region', { name: '我的偏好' })).toBeNull();
});
