// @vitest-environment jsdom
import { cleanup, act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  account: 'alice',
  listeners: new Set<() => void>(),
  upload: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => state.account,
  listPhotos: async () => [],
  uploadPhoto: state.upload,
  subscribeAuthChanges: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock('@0xnullai/auth/appearance', () => ({
  getCharacterAppearance: async () => ({
    photoId: 'old-photo',
    scale: 35,
    position: 'right',
    version: 2,
  }),
  saveCharacterAppearance: state.save,
}));
vi.mock('@0xnullai/auth/appearance-react', () => ({ CharacterPortrait: () => null }));
vi.mock('./CharacterAvatarDrawing', () => ({
  CharacterAvatarDrawing: ({ onSave }: { onSave: (blob: Blob) => Promise<void> }) => (
    <button onClick={() => void onSave(new Blob(['png'], { type: 'image/png' })).catch(() => {})}>
      确认测试画作
    </button>
  ),
}));
import { CharacterAppearancePanel } from './CharacterAppearancePanel';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.account = 'alice';
  state.listeners.clear();
});
describe('drawing appearance persistence', () => {
  it('uploads privately and changes appearance only after explicit drawing confirmation', async () => {
    state.upload.mockResolvedValue({ id: 'drawn-photo', caption: 'drawing' });
    state.save.mockResolvedValue({
      photoId: 'drawn-photo',
      version: 3,
      scale: 35,
      position: 'right',
    });
    render(<CharacterAppearancePanel relationshipId="relation" />);
    fireEvent.click(await screen.findByRole('button', { name: '给 AI 画头像' }));
    expect(state.upload).not.toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '确认测试画作' })));
    expect(state.upload).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({ visibility: 'private', purpose: 'album' }),
    );
    expect(state.save).toHaveBeenCalledWith(
      'relation',
      expect.objectContaining({ photoId: 'drawn-photo', version: 2 }),
    );
  });
  it('does not replace any avatar when account changes during upload', async () => {
    let finish!: (value: unknown) => void;
    state.upload.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<CharacterAppearancePanel relationshipId="relation" />);
    fireEvent.click(await screen.findByRole('button', { name: '给 AI 画头像' }));
    fireEvent.click(screen.getByRole('button', { name: '确认测试画作' }));
    await waitFor(() => expect(state.upload).toHaveBeenCalled());
    await act(async () => {
      state.account = 'bob';
      for (const listener of state.listeners) listener();
      finish({ id: 'drawn-photo' });
    });
    expect(state.save).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '确认测试画作' })).toBeNull();
  });
});
