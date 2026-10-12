import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SavedScene } from '@0xnullai/scenes';
import { ScenesTab } from './ScenesTab';

const state = vi.hoisted(() => ({
  openCharacter: vi.fn(async () => true),
  openScene: vi.fn(async () => true),
}));
vi.mock('@0xnullai/scenes/start-chat', () => ({
  openCharacterChat: state.openCharacter,
  openSceneChat: state.openScene,
}));
vi.mock('@0xnullai/scenes/library', () => ({
  SceneLibrary: ({ onStartChat }: { onStartChat?: (preset: SavedScene) => void }) =>
    onStartChat ? (
      <>
        <button
          type="button"
          onClick={() => onStartChat({ id: 'mine', name: '小夜', prompt: '', kind: 'character' })}
        >
          角色聊天
        </button>
        <button
          type="button"
          onClick={() => onStartChat({ id: 'rain', name: '雨夜', prompt: '', kind: 'scene' })}
        >
          场景聊天
        </button>
      </>
    ) : null,
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it('opens a character chat or a scene-only chat, then goes to the Agent chat', async () => {
  const openAgent = vi.fn();
  render(<ScenesTab onOpenAgent={openAgent} />);
  fireEvent.click(screen.getByRole('button', { name: '角色聊天' }));
  expect(state.openCharacter).toHaveBeenCalledWith('mine');
  await vi.waitFor(() => expect(openAgent).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: '场景聊天' }));
  expect(state.openScene).toHaveBeenCalledWith('rain');
  await vi.waitFor(() => expect(openAgent).toHaveBeenCalledTimes(2));
});

it('stays on the library when the chat could not open', async () => {
  state.openScene.mockResolvedValueOnce(false);
  const openAgent = vi.fn();
  render(<ScenesTab onOpenAgent={openAgent} />);
  fireEvent.click(screen.getByRole('button', { name: '场景聊天' }));
  await vi.waitFor(() => expect(state.openScene).toHaveBeenCalled());
  await Promise.resolve();
  expect(openAgent).not.toHaveBeenCalled();
});
