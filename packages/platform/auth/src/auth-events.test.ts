// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { me, subscribeAuthChanges, subscribeAuthUserUpdates, type AuthUser } from './index';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answers /api/auth/me and /api/auth/profile from mutable fixtures. */
function serveAccount(state: { user: AuthUser | null; avatarUrl: string | null }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/me')) return Response.json({ user: state.user });
      if (url.endsWith('/api/auth/profile'))
        return Response.json({ profile: { avatarUrl: state.avatarUrl } });
      return Response.json({ error: 'unexpected' }, { status: 404 });
    }),
  );
}

it('announces an account change only when the signed-in identity changes', async () => {
  const state = {
    user: { id: 'u1', username: 'a', displayName: 'A', emailVerified: false } as AuthUser | null,
    avatarUrl: null as string | null,
  };
  serveAccount(state);
  const changes: (string | null)[] = [];
  const updates: AuthUser[] = [];
  const offChanges = subscribeAuthChanges((user) => changes.push(user?.id ?? null));
  const offUpdates = subscribeAuthUserUpdates((user) => updates.push(user));
  try {
    await me();
    expect(changes).toEqual(['u1']);

    // The shell re-reads the same account on load, profile saves and retries.
    await me();
    await me();
    expect(changes).toEqual(['u1']);
    expect(updates).toEqual([]);

    // Same person, new profile fields: views showing them hear about it, account-scoped
    // state does not reset.
    state.user = { ...state.user!, displayName: 'A2', emailVerified: true };
    state.avatarUrl = '/avatar.png';
    await me();
    expect(changes).toEqual(['u1']);
    expect(updates.map((u) => [u.displayName, u.emailVerified, u.avatarUrl])).toEqual([
      ['A2', true, '/avatar.png'],
    ]);

    state.user = { id: 'u2', username: 'b', displayName: 'B' };
    await me();
    expect(changes).toEqual(['u1', 'u2']);

    state.user = null;
    await me();
    // Sign-out is always announced, even repeated: dropping account state is idempotent.
    await me();
    expect(changes).toEqual(['u1', 'u2', null, null]);
    expect(updates).toHaveLength(1);
  } finally {
    offChanges();
    offUpdates();
  }
});
