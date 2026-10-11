// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryReviewPanel } from './MemoryReviewPanel';

const api = vi.hoisted(() => ({
  listPersonalMemories: vi.fn(),
  getAutoMemorySettings: vi.fn(),
  getConversationDigestPreference: vi.fn(),
  setConversationDigestPreference: vi.fn(),
  getAccountMemoryAccess: vi.fn(),
  setAccountMemoryAccess: vi.fn(),
  deletePersonalMemory: vi.fn(),
  savePersonalMemory: vi.fn(),
  suggestConversationMemories: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => api);
beforeEach(() => {
  vi.resetAllMocks();
  api.listPersonalMemories.mockResolvedValue({ items: [] });
  api.getAutoMemorySettings.mockResolvedValue({
    item: { enabled: false, version: 0 },
    available: false,
  });
  api.getConversationDigestPreference.mockResolvedValue({
    item: { enabled: false, version: 0, updatedAt: null },
    available: true,
  });
  api.setConversationDigestPreference.mockResolvedValue({
    item: { enabled: true, version: 1, updatedAt: 1 },
    available: true,
  });
  api.getAccountMemoryAccess.mockResolvedValue({ enabled: false, version: 0, updatedAt: null });
  api.setAccountMemoryAccess.mockResolvedValue({ enabled: true, version: 1, updatedAt: 1 });
});
afterEach(cleanup);

it('keeps long-chat compression as a separate opt-in from fact extraction', async () => {
  render(<MemoryReviewPanel relationshipId="r" conversationId="c" />);
  const checkbox = await screen.findByLabelText('允许压缩这段关系的较早聊天');
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(api.setConversationDigestPreference).toHaveBeenCalledWith('r', true, 0),
  );
  expect((checkbox as HTMLInputElement).checked).toBe(true);
});

it('opens account-level facts only for the selected conversation using the server version', async () => {
  render(<MemoryReviewPanel relationshipId="r" conversationId="c" />);
  const checkbox = await screen.findByLabelText('允许本聊天读取账号级记忆');
  expect((checkbox as HTMLInputElement).checked).toBe(false);
  fireEvent.click(checkbox);
  await waitFor(() => expect(api.setAccountMemoryAccess).toHaveBeenCalledWith('c', true, 0));
  expect((checkbox as HTMLInputElement).checked).toBe(true);
});

it('keeps account-level facts closed when the access endpoint is unavailable', async () => {
  api.getAccountMemoryAccess
    .mockRejectedValueOnce(new Error('绑定未验证'))
    .mockResolvedValueOnce({ enabled: false, version: 0, updatedAt: null });
  render(<MemoryReviewPanel relationshipId="r" conversationId="c" />);
  expect(await screen.findByText('绑定未验证')).toBeTruthy();
  expect(screen.queryByLabelText('允许本聊天读取账号级记忆')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试读取' }));
  expect(await screen.findByLabelText('允许本聊天读取账号级记忆')).toBeTruthy();
});

it('shows candidate sources and rejects only the selected relationship memory', async () => {
  api.listPersonalMemories.mockResolvedValueOnce({
    items: [
      {
        id: 'candidate-1',
        version: 2,
        title: '一起看过电影',
        content: '周五一起看过电影',
        kind: 'event',
        tier: 'history',
        state: 'suggested',
        sourceRefs: [
          { conversationId: 'c', messageId: 'message-a' },
          { conversationId: 'other-c', messageId: 'message-b' },
        ],
      },
    ],
  });
  api.deletePersonalMemory.mockResolvedValue({ ok: true });
  render(<MemoryReviewPanel relationshipId="relationship-1" conversationId="c" />);
  expect(api.listPersonalMemories).toHaveBeenCalledWith('relationship-1');
  expect(await screen.findByText('一起看过电影')).toBeTruthy();
  expect(screen.getByText(/仅属于当前账号的这个角色关系/)).toBeTruthy();
  fireEvent.click(screen.getByText(/来源：同一私人关系的/));
  expect(screen.getByText(/当前聊天 · 会话 c · 消息 message-a/)).toBeTruthy();
  expect(screen.getByText(/其他聊天 · 会话 other-c · 消息 message-b/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '拒绝候选 一起看过电影' }));
  await waitFor(() => expect(api.deletePersonalMemory).toHaveBeenCalledWith('candidate-1', 2));
  expect(await screen.findByText('已拒绝候选；相同来源不会自动重新生成')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('一起看过电影')).toBeNull());
});

it('confirms a sourced candidate inside the selected relationship', async () => {
  const candidate = {
    id: 'candidate-2',
    version: 1,
    title: '喜欢海边',
    content: '用户说喜欢海边',
    kind: 'preference',
    tier: 'long',
    state: 'suggested',
    sourceConversationId: 'c',
    sourceMessageIds: ['message-c'],
  };
  api.listPersonalMemories.mockResolvedValue({ items: [candidate] });
  api.savePersonalMemory.mockResolvedValue({ item: { ...candidate, version: 2, state: 'active' } });
  render(<MemoryReviewPanel relationshipId="relationship-2" conversationId="c" />);
  fireEvent.click(await screen.findByRole('button', { name: '确认是真实记忆' }));
  await waitFor(() =>
    expect(api.savePersonalMemory).toHaveBeenCalledWith({
      id: 'candidate-2',
      version: 1,
      kind: 'preference',
      title: '喜欢海边',
      content: '用户说喜欢海边',
      scope: 'relationship',
      relationshipId: 'relationship-2',
      tier: 'long',
      state: 'active',
    }),
  );
  expect(await screen.findByText('已确认记忆，可用于这段私人关系的后续对话')).toBeTruthy();
});

it('shows scoped automatic memory backlog and paused failures', async () => {
  api.getAutoMemorySettings.mockResolvedValue({
    item: { enabled: true, version: 1 },
    available: true,
    progress: { queued: 4, retrying: 1, paused: 1 },
  });
  render(<MemoryReviewPanel relationshipId="r" conversationId="c" />);
  expect((await screen.findByRole('status')).textContent).toContain(
    '待处理 4 段会话，其中 1 段重试中；1 段因连续失败暂停',
  );
});
