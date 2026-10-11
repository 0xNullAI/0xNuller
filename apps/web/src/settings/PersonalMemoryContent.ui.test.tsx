import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonalMemoryContent } from './PersonalMemoryContent';
import {
  deletePersonalMemory,
  exportPersonalMemories,
  listPersonalMemories,
  savePersonalMemory,
  listHumanMemoryConversations,
  listHumanMemoryShares,
  listReceivedHumanMemories,
  setHumanMemoryShare,
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
  listHumanMemoryConversations: vi.fn(),
  listHumanMemoryShares: vi.fn(),
  listReceivedHumanMemories: vi.fn(),
  setHumanMemoryShare: vi.fn(),
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
  vi.mocked(listHumanMemoryConversations).mockResolvedValue({ conversations: [], next: null });
  vi.mocked(listHumanMemoryShares).mockResolvedValue({ shares: [] });
  vi.mocked(listReceivedHumanMemories).mockResolvedValue({ items: [], nextOffset: null });
});

it('shares only the chosen memory in the chosen human chat and can revoke it', async () => {
  const chat = { kind: 'dm' as const, id: 'bob', name: '小波' };
  vi.mocked(listHumanMemoryConversations).mockResolvedValue({ conversations: [chat], next: null });
  vi.mocked(setHumanMemoryShare)
    .mockResolvedValueOnce({ share: { memoryId: 'm1', enabled: true, version: 1, updatedAt: 2 } })
    .mockResolvedValueOnce({ share: { memoryId: 'm1', enabled: false, version: 2, updatedAt: 3 } });
  render(<PersonalMemoryContent />);
  fireEvent.click(await screen.findByRole('button', { name: '共享 小林' }));
  await screen.findByRole('button', { name: '撤销共享 小林' });
  expect(setHumanMemoryShare).toHaveBeenCalledWith(chat, memory, { enabled: true, version: 0 });
  fireEvent.click(screen.getByRole('button', { name: '撤销共享 小林' }));
  await screen.findByRole('button', { name: '共享 小林' });
  expect(setHumanMemoryShare).toHaveBeenLastCalledWith(chat, memory, {
    enabled: false,
    version: 1,
  });
  expect(screen.getByText(/已经看过或复制的内容无法收回/)).toBeTruthy();
});

it('opens a deep-linked conversation even when it is older than the first list page', async () => {
  const target = { kind: 'group' as const, id: 'old-room' };
  const recent = { kind: 'dm' as const, id: 'bob', name: '小波' };
  vi.mocked(listHumanMemoryConversations).mockResolvedValue({
    conversations: [recent],
    next: { dmOffset: null, groupOffset: 100 },
  });
  render(<PersonalMemoryContent initialChat={target} />);
  await screen.findByRole('option', { name: '群聊 · old-room' });
  await waitFor(() =>
    expect(listHumanMemoryShares).toHaveBeenCalledWith({ ...target, name: target.id }),
  );
  expect((screen.getByLabelText('选择记忆共享聊天') as HTMLSelectElement).value).toBe(
    'group:old-room',
  );
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
  fireEvent.click(await screen.findByRole('button', { name: '编辑 小林' }));
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(finishOldSave).toBeTypeOf('function'));
  await act(async () => {
    authAccount = 'bob';
    for (const listener of authListeners) listener({ id: 'bob' } as never);
    authAccount = 'alice';
    for (const listener of authListeners) listener({ id: 'alice' } as never);
  });
  await screen.findByRole('button', { name: '添加记忆' });
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

it('removes a displayed share on account change and ignores a late conversation result', async () => {
  const aliceChat = { kind: 'dm' as const, id: 'peer-a', name: 'A 私聊' };
  const bobChat = { kind: 'dm' as const, id: 'peer-b', name: 'B 私聊' };
  let finishBob!: (value: { conversations: (typeof bobChat)[]; next: null }) => void;
  vi.mocked(listHumanMemoryConversations)
    .mockResolvedValueOnce({ conversations: [aliceChat], next: null })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBob = resolve;
        }),
    )
    .mockResolvedValueOnce({ conversations: [aliceChat], next: null });
  vi.mocked(listReceivedHumanMemories)
    .mockResolvedValueOnce({
      items: [
        {
          ownerId: 'peer-a',
          ownerName: '旧共享者',
          memory: {
            id: 'shared',
            kind: 'note',
            title: '旧共享',
            content: '旧账号内容',
            version: 1,
            updatedAt: 1,
          },
        },
      ],
      nextOffset: null,
    })
    .mockResolvedValue({ items: [], nextOffset: null });
  render(<PersonalMemoryContent />);
  await screen.findByText('旧账号内容');
  await act(async () => {
    authAccount = 'bob';
    for (const listener of authListeners) listener({ id: 'bob' } as never);
  });
  expect(screen.queryByText('旧账号内容')).toBeNull();
  await waitFor(() => expect(finishBob).toBeTypeOf('function'));
  await act(async () => {
    authAccount = 'alice';
    for (const listener of authListeners) listener({ id: 'alice' } as never);
    finishBob({ conversations: [bobChat], next: null });
  });
  await screen.findByRole('option', { name: '私聊 · A 私聊' });
  expect(screen.queryByRole('option', { name: '私聊 · B 私聊' })).toBeNull();
  expect(screen.queryByText('旧账号内容')).toBeNull();
});

it('edits and deletes server memories using their current version', async () => {
  vi.mocked(savePersonalMemory).mockResolvedValue({
    item: { ...memory, content: '改到周六', version: 2 },
  });
  vi.mocked(deletePersonalMemory).mockResolvedValue({ ok: true });
  render(<PersonalMemoryContent />);
  fireEvent.click(await screen.findByRole('button', { name: '编辑 小林' }));
  fireEvent.change(screen.getByLabelText('记忆内容'), { target: { value: '改到周六' } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await screen.findByText('改到周六');
  expect(savePersonalMemory).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'm1', version: 1, content: '改到周六' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '删除 小林' }));
  await screen.findByText('还没有个人记忆。');
  expect(deletePersonalMemory).toHaveBeenCalledWith('m1', 2);
});

it('keeps unsaved edits visible when the server rejects a conflict', async () => {
  vi.mocked(savePersonalMemory).mockRejectedValue(new Error('记忆已变更，请刷新后重试'));
  render(<PersonalMemoryContent />);
  fireEvent.click(await screen.findByRole('button', { name: '编辑 小林' }));
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
  fireEvent.click(await screen.findByRole('button', { name: '编辑 小林' }));
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
  await screen.findByText('还没有个人记忆。');
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
  fireEvent.click(screen.getByRole('button', { name: '导出' }));
  await screen.findByText('已导出全部记忆');
  expect(exportPersonalMemories).toHaveBeenCalledOnce();
  expect(click).toHaveBeenCalledOnce();
  const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
  expect(JSON.parse(await blob.text())).toEqual({ format: '0xnuller-memories', memories: [] });
  click.mockRestore();
});
