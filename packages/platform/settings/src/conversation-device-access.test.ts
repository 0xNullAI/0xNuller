// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import {
  deviceConversationAccess,
  setDeviceConversationAccess,
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
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw new Error('quota');
  };
  try {
    expect(setDeviceConversationAccess('alice', 'group', 'room', true)).toBe(false);
    expect(deviceConversationAccess('alice', 'group', 'room')).toBe(false);
  } finally {
    Storage.prototype.setItem = original;
  }
});
