// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import {
  deviceConversationAccess,
  groupAiDeviceAccess,
  setDeviceConversationAccess,
  setGroupAiDeviceAccess,
  subscribeDeviceConversationAccess,
} from './conversation-device-access';
beforeEach(() => {
  localStorage.clear();
});
it('denies by default, scopes grants by account and exact room, and does not grant on storage failure', () => {
  expect(deviceConversationAccess('alice', 'ai', 'session')).toBe(false);
  const listener = vi.fn();
  const unsub = subscribeDeviceConversationAccess(listener);
  expect(setDeviceConversationAccess('alice', 'ai', 'session', true)).toBe(true);
  expect(deviceConversationAccess('alice', 'ai', 'session')).toBe(true);
  expect(deviceConversationAccess('bob', 'ai', 'session')).toBe(false);
  expect(deviceConversationAccess('alice', 'dm', 'session')).toBe(false);
  expect(deviceConversationAccess('alice', 'ai', 'other')).toBe(false);
  expect(setDeviceConversationAccess('alice', 'ai', 'session', false)).toBe(true);
  expect(deviceConversationAccess('alice', 'ai', 'session')).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
  unsub();
  // The prototype, not the instance: jsdom's Storage turns an own property into a stored item,
  // and Node 26 without its web storage flag runs on the in-memory stand-in instead.
  const failing = vi.spyOn(Object.getPrototypeOf(localStorage) as Storage, 'setItem');
  failing.mockImplementation(() => {
    throw new Error('quota');
  });
  try {
    expect(setDeviceConversationAccess('alice', 'group', 'room', true)).toBe(false);
    expect(deviceConversationAccess('alice', 'group', 'room')).toBe(false);
  } finally {
    failing.mockRestore();
  }
});

it('scopes a group AI grant to one AI in one group, apart from the group consent for people', () => {
  expect(groupAiDeviceAccess('alice', 'g1', 'a1')).toBe(false);
  expect(setGroupAiDeviceAccess('alice', 'g1', 'a1', true)).toBe(true);
  expect(groupAiDeviceAccess('alice', 'g1', 'a1')).toBe(true);
  expect(groupAiDeviceAccess('alice', 'g1', 'a2')).toBe(false);
  expect(groupAiDeviceAccess('alice', 'g2', 'a1')).toBe(false);
  expect(groupAiDeviceAccess('bob', 'g1', 'a1')).toBe(false);
  expect(groupAiDeviceAccess(null, 'g1', 'a1')).toBe(false);
  expect(deviceConversationAccess('alice', 'group', 'g1')).toBe(false);
  expect(setDeviceConversationAccess('alice', 'group', 'g1', true)).toBe(true);
  expect(groupAiDeviceAccess('alice', 'g1', 'a2')).toBe(false);
});
