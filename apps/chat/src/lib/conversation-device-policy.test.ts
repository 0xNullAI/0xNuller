import { expect, it, vi } from 'vitest';
import { chatConversationAllowsCommand, groupAiCommandRefusal } from './conversation-device-policy';
const read = vi.hoisted(() => vi.fn());
const aiRead = vi.hoisted(() => vi.fn());
vi.mock('@0xnullai/settings', () => ({
  deviceConversationAccess: read,
  groupAiDeviceAccess: aiRead,
}));
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
it('lets a group AI act only with consent for that exact AI in that group', () => {
  aiRead.mockReturnValue(false);
  expect(groupAiCommandRefusal('user', 'g1', false, 'a1', ['a1'], 'adjust_strength')).toBe(
    '对方没有允许这个 AI 控制设备',
  );
  expect(aiRead).toHaveBeenLastCalledWith('user', 'g1', 'a1');
  aiRead.mockReturnValue(true);
  expect(groupAiCommandRefusal('user', 'g1', false, 'a1', ['a1'], 'adjust_strength')).toBeNull();
  expect(groupAiCommandRefusal('user', 'g1', false, 'a2', ['a1'], 'change_wave')).toBe(
    '这个 AI 不在当前群里',
  );
  expect(groupAiCommandRefusal('user', 'dm', true, 'a1', ['a1'], 'change_wave')).toBe(
    '这个 AI 不在当前群里',
  );
  expect(groupAiCommandRefusal('user', 'g1', false, 'a1', ['a1'], 'alert')).toBe('不支持这个操作');
  expect(groupAiCommandRefusal('user', 'g1', false, 'a1', ['a1'], 'fire_active')).toBe(
    '不支持这个操作',
  );
});
it('lets any group AI stop output without consent', () => {
  aiRead.mockReturnValue(false);
  expect(groupAiCommandRefusal(null, null, false, 'gone', [], 'stop')).toBeNull();
  expect(groupAiCommandRefusal(null, null, false, 'gone', [], 'vibrate_stop')).toBeNull();
});
