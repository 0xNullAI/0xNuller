import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ account: 'alice', listeners: new Set<() => void>() }));
vi.mock('./index', () => ({
  currentAuthUserId: () => state.account,
  authRequestHeaders: () => ({ Authorization: 'Bearer test' }),
  subscribeAuthChanges: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock('@0xnullai/settings', () => ({ apiBaseUrl: () => 'https://platform.test' }));
import { CharacterPortrait } from './character-appearance-react';
import { characterPhotoPath } from './character-appearance';
afterEach(() => {
  vi.unstubAllGlobals();
  state.account = 'alice';
  state.listeners.clear();
});
describe('private character image', () => {
  it('only resolves platform IDs and rejects external or traversal paths', () => {
    expect(characterPhotoPath('photo-1')).toBe('/api/auth/photos/photo-1/content');
    for (const input of ['https://tracker.test/x', '../other', 'x/content?foo', 'data:image/png'])
      expect(() => characterPhotoPath(input)).toThrow();
  });
  it('fetches with account auth and clears/revokes on account change', async () => {
    const create = vi.fn(() => 'blob:photo');
    const revoke = vi.fn();
    vi.spyOn(URL, 'createObjectURL').mockImplementation(create);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke);
    const fetcher = vi.fn(
      async () =>
        // Plain bytes: a jsdom Blob is not a body Node 22's fetch Response accepts.
        new Response(new TextEncoder().encode('image'), {
          headers: { 'content-type': 'image/png' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const view = render(
      <CharacterPortrait photoId="photo-1" speaking fallbackSource="blob:public" />,
    );
    await waitFor(() => expect(screen.getByAltText('私人角色形象')).toBeTruthy());
    expect(screen.queryByAltText('公开角色形象')).toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      'https://platform.test/api/auth/photos/photo-1/content',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Account-Id': 'alice', Authorization: 'Bearer test' }),
      }),
    );
    act(() => {
      state.account = 'bob';
      for (const listener of state.listeners) listener();
    });
    expect(screen.queryByAltText('私人角色形象')).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:photo');
    view.unmount();
    vi.restoreAllMocks();
  });
});

it('uses a decoded public blob only as fallback and never accepts an external image URL', async () => {
  const { fireEvent, cleanup } = await import('@testing-library/react');
  const view = render(<CharacterPortrait photoId={null} fallbackSource="blob:public" />);
  expect(screen.getByAltText('公开角色形象').getAttribute('src')).toBe('blob:public');
  fireEvent.error(screen.getByAltText('公开角色形象'));
  expect(screen.getByLabelText('默认角色形象')).toBeTruthy();
  view.rerender(<CharacterPortrait photoId={null} fallbackSource="https://tracker.test/avatar" />);
  expect(screen.queryByRole('img')).toBeNull();
  cleanup();
});
