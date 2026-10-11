// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MarketItem } from '../../shared/schema';
import { DiscoveryFeedbackAction, DiscoveryFeedbackManager } from './DiscoveryFeedback';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../api', () => ({
  listDiscoveryFeedback: api.list,
  saveDiscoveryFeedback: api.save,
  deleteDiscoveryFeedback: api.remove,
}));
beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue([
    {
      kind: 'item',
      targetId: 'card',
      sourceItemName: '小岚',
      reason: 'too_similar',
      createdAt: 1,
    },
  ]);
  api.save.mockResolvedValue({ kind: 'item', targetId: 'card' });
  api.remove.mockResolvedValue(undefined);
});
afterEach(cleanup);

const card = {
  id: 'card',
  type: 'scenario',
  name: '小岚',
  content: { prompt: '人设' },
  tags: [],
  views: 0,
  downloads: 0,
  createdAt: 1,
  verifiedCreator: { id: 'creator', username: 'real', displayName: '真实作者' },
} as MarketItem;

it('sends an explicit reason and trusted creator id, then removes the suggestion', async () => {
  const saved = vi.fn();
  render(<DiscoveryFeedbackAction item={card} onSaved={saved} />);
  fireEvent.change(screen.getByRole('combobox', { name: '对小岚的推荐反馈' }), {
    target: { value: 'hide_creator' },
  });
  fireEvent.click(screen.getByRole('button', { name: '应用偏好' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith('card', 'hide_creator', 'creator'));
  expect(saved).toHaveBeenCalledOnce();
});

it('lists only account preferences and explicitly undoes a suppressed item', async () => {
  const removed = vi.fn();
  render(<DiscoveryFeedbackManager revision={0} onRemoved={removed} />);
  expect(await screen.findByText('少看相似标签：小岚')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  await waitFor(() => expect(api.remove).toHaveBeenCalledWith('item', 'card'));
  expect(removed).toHaveBeenCalledOnce();
});
