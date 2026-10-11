// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentWorkspacePanel } from './AgentWorkspacePanel';
const api = vi.hoisted(() => ({
  listAgentTasks: vi.fn(),
  saveAgentTask: vi.fn(),
  deleteAgentTask: vi.fn(),
  listConversationFiles: vi.fn(),
  readConversationFile: vi.fn(),
  uploadConversationFile: vi.fn(),
  deleteConversationFile: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => api);
beforeEach(() => {
  vi.resetAllMocks();
  api.listAgentTasks.mockResolvedValue({ items: [] });
  api.listConversationFiles.mockResolvedValue({ items: [] });
  api.saveAgentTask.mockImplementation(async (conversationId, input) => ({
    item: { ...input, conversationId, version: input.version + 1 },
  }));
});
afterEach(cleanup);
it('creates a visible plan and updates a step through versioned server writes', async () => {
  render(<AgentWorkspacePanel conversationId="conversation" />);
  fireEvent.change(await screen.findByLabelText('任务计划标题'), { target: { value: '读书会' } });
  fireEvent.change(screen.getByLabelText('任务计划步骤'), { target: { value: '选择书籍' } });
  fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
  const checkbox = await screen.findByRole('checkbox');
  expect(api.saveAgentTask).toHaveBeenCalledWith(
    'conversation',
    expect.objectContaining({ version: 0, title: '读书会', status: 'planned' }),
  );
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(api.saveAgentTask).toHaveBeenLastCalledWith(
      'conversation',
      expect.objectContaining({
        version: 1,
        status: 'completed',
        steps: [expect.objectContaining({ title: '选择书籍', status: 'done' })],
      }),
    ),
  );
});
it('uploads decoded file content into the current conversation without executing it', async () => {
  api.uploadConversationFile.mockImplementation(async (conversationId, input) => ({
    item: { ...input, conversationId, version: 1, byteLength: 10 },
  }));
  render(<AgentWorkspacePanel conversationId="conversation" />);
  const upload = await screen.findByLabelText('上传文本或 Markdown');
  const content = '# 文档\n<脚本>只是文字';
  const bytes = new TextEncoder().encode(content);
  fireEvent.change(upload, {
    target: {
      files: [
        {
          name: 'notes.md',
          size: bytes.length,
          type: 'text/markdown',
          arrayBuffer: async () => bytes.buffer,
        },
      ],
    },
  });
  await waitFor(() =>
    expect(api.uploadConversationFile).toHaveBeenCalledWith(
      'conversation',
      expect.objectContaining({ name: 'notes.md', mime: 'text/markdown', content }),
    ),
  );
  expect(await screen.findByRole('button', { name: '查看文件 notes.md' })).toBeTruthy();
});
