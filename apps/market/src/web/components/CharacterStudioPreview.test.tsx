// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyCharacterCard } from '@0xnullai/scenes/character-card';
import { CharacterStudioPreview } from './CharacterStudioPreview';
const api = vi.hoisted(() => ({
  owner: 'a',
  listeners: new Set<() => void>(),
  catalog: vi.fn(),
  turn: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => api.owner,
  subscribeAuthChanges: (listener: () => void) => {
    api.listeners.add(listener);
    return () => api.listeners.delete(listener);
  },
}));
vi.mock('../character-preview', () => ({ previewCatalog: api.catalog, previewTurn: api.turn }));
const snapshot = { name: '试聊角色', prompt: '当前草稿', card: emptyCharacterCard() };
beforeEach(() => {
  vi.clearAllMocks();
  api.owner = 'a';
  api.catalog.mockResolvedValue({
    models: [
      {
        id: 'basic',
        name: '基础',
        inputCreditsPerMillion: 12,
        outputCreditsPerMillion: 34,
        priceVersion: 'live',
      },
    ],
    credit: { available: 20 },
  });
  api.turn.mockResolvedValue({ text: '模型真实结果', charged: 0.5 });
});
afterEach(cleanup);
it('requires explicit paid send, shows live costs and renders the actual result', async () => {
  render(<CharacterStudioPreview snapshot={snapshot} />);
  fireEvent.click(screen.getByText('试聊当前草稿'));
  await screen.findByText(/当前可用 20/);
  expect(api.turn).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('试聊输入'), { target: { value: '你好' } });
  fireEvent.click(screen.getByText('发送并使用 Credit'));
  await screen.findByText('本次已结算 0.5 Credit');
  expect(screen.getByRole('log').textContent).toContain('模型真实结果');
  expect(api.turn).toHaveBeenCalledWith(
    snapshot,
    [{ role: 'user', content: '你好' }],
    'basic',
    'a',
    expect.any(AbortSignal),
  );
});
it('stops on cancellation and draft replacement and rejects late replies', async () => {
  let complete!: (value: { text: string; charged: number }) => void;
  api.turn.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const view = render(<CharacterStudioPreview key="old" snapshot={snapshot} />);
  fireEvent.click(screen.getByText('试聊当前草稿'));
  await screen.findByText(/当前可用 20/);
  fireEvent.change(screen.getByLabelText('试聊输入'), { target: { value: '你好' } });
  fireEvent.click(screen.getByText('发送并使用 Credit'));
  const signal = api.turn.mock.calls[0]![4] as AbortSignal;
  fireEvent.click(screen.getByText('停止试聊'));
  expect(signal.aborted).toBe(true);
  view.rerender(<CharacterStudioPreview key="new" snapshot={{ ...snapshot, prompt: '新版' }} />);
  await act(async () => complete({ text: '旧回复', charged: 1 }));
  expect(screen.queryByText('旧回复')).toBeNull();
  expect(screen.queryByRole('log')).toBeNull();
});
it('revokes the preview permanently on account A to B to A', async () => {
  render(<CharacterStudioPreview snapshot={snapshot} />);
  fireEvent.click(screen.getByText('试聊当前草稿'));
  await screen.findByText(/当前可用 20/);
  act(() => {
    api.owner = 'b';
    api.listeners.forEach((listener) => listener());
    api.owner = 'a';
    api.listeners.forEach((listener) => listener());
  });
  await waitFor(() => expect(screen.getByText('请登录并重新打开编辑器后试聊。')).toBeTruthy());
  expect(screen.queryByLabelText('试聊输入')).toBeNull();
});
