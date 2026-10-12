import { afterEach, expect, it, vi } from 'vitest';
import { subscribeChatRouteChanges } from './chat-route-changes';
import type { InitialChatTarget } from './initial-chat-target';

let unsubscribe: () => void = () => undefined;
afterEach(() => {
  unsubscribe();
  window.history.replaceState(null, '', '/');
});

function navigate(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

it('selects a new DM or group when only the mounted Chat query changes', () => {
  let current: InitialChatTarget = { kind: 'dm', accountId: 'alice' };
  const select = vi.fn((target: InitialChatTarget) => {
    current = target;
  });
  window.history.replaceState(null, '', '/chat?dm=alice');
  unsubscribe = subscribeChatRouteChanges({
    accountId: () => 'owner',
    isCurrent: (target) => JSON.stringify(target) === JSON.stringify(current),
    select,
  });
  navigate('/chat?dm=bob');
  expect(select).toHaveBeenLastCalledWith({ kind: 'dm', accountId: 'bob' });
  navigate('/chat?room=group-1');
  expect(select).toHaveBeenLastCalledWith({ kind: 'room', code: 'group-1' });
  navigate('/chat?room=group-1');
  expect(select).toHaveBeenCalledTimes(2);
});

it('rejects routes without an account and reopens a stale URL after a different selection', () => {
  let account: string | null = null;
  let current: InitialChatTarget = { kind: 'room', code: 'other-group' };
  const select = vi.fn();
  unsubscribe = subscribeChatRouteChanges({
    accountId: () => account,
    isCurrent: (target) => JSON.stringify(target) === JSON.stringify(current),
    select,
  });
  navigate('/chat?dm=bob');
  expect(select).not.toHaveBeenCalled();
  account = 'owner';
  navigate('/chat?dm=bob');
  expect(select).toHaveBeenCalledWith({ kind: 'dm', accountId: 'bob' });
  select.mockClear();
  current = { kind: 'room', code: 'other-group' };
  navigate('/agent?conversation=bob');
  navigate('/chat?dm=%2Fcontrol');
  expect(select).not.toHaveBeenCalled();
  navigate('/chat?dm=bob');
  expect(select).toHaveBeenCalledWith({ kind: 'dm', accountId: 'bob' });
});

it('opens each new-group request after Chat is already mounted and consumes only that query', () => {
  const openCreate = vi.fn();
  const select = vi.fn();
  unsubscribe = subscribeChatRouteChanges({
    accountId: () => 'owner',
    isCurrent: () => false,
    select,
    openCreate,
  });
  navigate('/chat?create=1');
  expect(openCreate).toHaveBeenCalledOnce();
  expect(window.location.pathname + window.location.search).toBe('/chat');
  navigate('/market');
  navigate('/chat?create=1');
  expect(openCreate).toHaveBeenCalledTimes(2);
  expect(select).not.toHaveBeenCalled();
});
