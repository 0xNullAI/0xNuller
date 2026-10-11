// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionMediaPanel } from './CompanionMediaPanel';
const api = vi.hoisted(() => ({
  createMediaJob: vi.fn(),
  deleteMediaJob: vi.fn(),
  listMediaCapabilities: vi.fn(),
  listMediaJobs: vi.fn(),
  mediaJobBlob: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => api);
const offer = {
  kind: 'image',
  model: 'image-01',
  credits: 20,
  priceVersion: 'v1',
  enabled: true,
  reason: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  api.listMediaCapabilities.mockResolvedValue({ items: [offer] });
  api.listMediaJobs.mockResolvedValue({ items: [] });
  api.createMediaJob.mockResolvedValue({
    item: { id: 'job', kind: 'image', state: 'queued', prompt: 'scene' },
  });
});
afterEach(cleanup);
describe('private generated media panel', () => {
  it('requires an available quoted capability and sends context only when explicitly selected', async () => {
    render(<CompanionMediaPanel accountId="alice" relationshipId="r" conversationId="c" />);
    await screen.findByText(/本次预留 20/);
    fireEvent.change(screen.getByLabelText('画面描述'), { target: { value: 'scene' } });
    fireEvent.click(screen.getByText('确认生成'));
    await waitFor(() =>
      expect(api.createMediaJob).toHaveBeenCalledWith(
        expect.objectContaining({
          relationshipId: 'r',
          conversationId: 'c',
          acceptedCredits: 20,
          priceVersion: 'v1',
          useConversationContext: false,
          useCharacterContext: false,
          prompt: 'scene',
        }),
      ),
    );
  });
  it('opts in to the account-owned character and scene snapshot separately from messages', async () => {
    render(<CompanionMediaPanel accountId="alice" relationshipId="r" conversationId="c" />);
    await screen.findByText(/本次预留 20/);
    fireEvent.change(screen.getByLabelText('画面描述'), { target: { value: 'scene' } });
    fireEvent.click(screen.getByText(/将我的角色卡和当前场景设定/));
    fireEvent.click(screen.getByText('确认生成'));
    await waitFor(() =>
      expect(api.createMediaJob).toHaveBeenCalledWith(
        expect.objectContaining({ useCharacterContext: true, useConversationContext: false }),
      ),
    );
  });
  it('disables submission without provider credentials', async () => {
    api.listMediaCapabilities.mockResolvedValue({
      items: [{ ...offer, enabled: false, reason: '管理员尚未配置媒体服务' }],
    });
    render(<CompanionMediaPanel accountId="alice" relationshipId="r" conversationId="c" />);
    await screen.findByText('管理员尚未配置媒体服务');
    expect((screen.getByText('确认生成') as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows a reviewed asset without offering preview or deletion before reconciliation', async () => {
    api.listMediaJobs.mockResolvedValue({
      items: [
        {
          id: 'reviewed-job',
          kind: 'image',
          state: 'needs_review',
          prompt: 'scene',
          lastError: '媒体账务待核对；未追加扣费',
        },
      ],
    });
    render(<CompanionMediaPanel accountId="alice" relationshipId="r" conversationId="c" />);
    await screen.findByText('生成图片 · 账务待核对');
    expect(screen.queryByText('查看图片')).toBeNull();
    expect(screen.queryByText('删除')).toBeNull();
  });
});
