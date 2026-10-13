import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ account: 'alice', listeners: new Set<() => void>() }));
vi.mock('./index', () => ({
  currentAuthUserId: () => state.account,
  authRequestHeaders: () => ({}),
  subscribeAuthChanges: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock('@0xnullai/settings', () => ({ apiBaseUrl: () => 'https://platform.test' }));
import { CharacterPortrait, useCharacterAppearance } from './character-appearance-react';
import { acquireCharacterPhoto } from './character-asset-cache';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  state.account = 'alice';
});

const png = () =>
  new Response(new TextEncoder().encode('image'), { headers: { 'content-type': 'image/png' } });

it('every avatar of a conversation shares one photo read and one object URL', async () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:shared');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const fetcher = vi.fn(async () => png());
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    <>
      <CharacterPortrait photoId="shared-1" />
      <CharacterPortrait photoId="shared-1" />
      <CharacterPortrait photoId="shared-1" />
    </>,
  );
  await waitFor(() => expect(screen.getAllByAltText('私人角色形象')).toHaveLength(3));
  expect(fetcher).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();
  view.unmount();
});

it('releases the bytes once nothing has held them for a while', async () => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:idle');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const load = vi.fn(async () => new Blob(['x']));
  const first = acquireCharacterPhoto('alice', 'idle-1', load);
  expect(await first.url).toBe('blob:idle');
  vi.useFakeTimers();
  first.release();
  // Re-acquired before the idle window ends: no new read, nothing revoked.
  const second = acquireCharacterPhoto('alice', 'idle-1', load);
  expect(await second.url).toBe('blob:idle');
  expect(load).toHaveBeenCalledOnce();
  second.release();
  vi.advanceTimersByTime(60_000);
  expect(revoke).toHaveBeenCalledWith('blob:idle');
});

it('drops another account’s photo bytes the moment the account changes', async () => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:alice');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const lease = acquireCharacterPhoto('alice', 'private-1', async () => new Blob(['x']));
  await lease.url;
  act(() => {
    state.account = 'bob';
    for (const listener of state.listeners) listener();
  });
  expect(revoke).toHaveBeenCalledWith('blob:alice');
  lease.release();
});

it('reads one relationship appearance once for all of its avatars', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ item: { photoId: null, scale: 35, position: 'right' } }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  function Probe() {
    const appearance = useCharacterAppearance('rel-1');
    return <span>{appearance ? 'ready' : 'loading'}</span>;
  }
  const view = render(
    <>
      <Probe />
      <Probe />
      <Probe />
    </>,
  );
  await waitFor(() => expect(screen.getAllByText('ready')).toHaveLength(3));
  expect(fetcher).toHaveBeenCalledOnce();
  // A saved appearance invalidates the shared read.
  await act(async () => {
    window.dispatchEvent(new Event('0xnullai:appearance-changed'));
  });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  view.unmount();
});
