import { expect, it, vi } from 'vitest';
import { chatConversationAllowsCommand } from './conversation-device-policy';
const read = vi.hoisted(() => vi.fn());
vi.mock('@0xnullai/settings', () => ({ deviceConversationAccess: read }));
it('requires the exact account and conversation consent for human and AI commands', () => {
  read.mockReturnValue(false);
  expect(chatConversationAllowsCommand('user', 'room', false, 'start')).toBe(false);
  expect(read).toHaveBeenLastCalledWith('user', 'group', 'room');
  read.mockReturnValue(true);
  expect(chatConversationAllowsCommand('user', 'dm', true, 'adjust_strength')).toBe(true);
  expect(read).toHaveBeenLastCalledWith('user', 'dm', 'dm');
  expect(chatConversationAllowsCommand('user', null, false, 'start')).toBe(false);
});
it('preserves all stop and release routes even after consent and account disappear', () => {
  read.mockReturnValue(false);
  for (const action of ['stop', 'stop_wave', 'vibrate_stop', 'fire_release'] as const)
    expect(chatConversationAllowsCommand(null, null, false, action)).toBe(true);
});
