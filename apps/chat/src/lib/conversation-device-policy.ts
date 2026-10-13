import { deviceConversationAccess, groupAiDeviceAccess } from '@0xnullai/settings';
import type { CmdAction } from './protocol';

/** Output-reducing preemption stays reachable after revocation or loss of a lease. */
const STOP_ACTIONS: readonly CmdAction[] = ['stop', 'stop_wave', 'vibrate_stop', 'fire_release'];

/** Consent is an additional gate; it grants neither a lease nor a physical target. */
export function chatConversationAllowsCommand(
  accountId: string | null,
  roomId: string | null,
  isDm: boolean,
  action: CmdAction,
): boolean {
  if (STOP_ACTIONS.includes(action)) return true;
  return !!roomId && deviceConversationAccess(accountId, isDm ? 'dm' : 'group', roomId);
}

/** The only commands a group AI's tools produce; anything else under an AI's name is refused. */
const GROUP_AI_ACTIONS: readonly CmdAction[] = [
  'adjust_strength',
  'change_wave',
  'stop_wave',
  'stop',
  'vibrate_adjust',
  'vibrate_stop',
];

/**
 * Why this device refuses a group AI's command, or null to carry it out. The AI must be in
 * this group right now and this account must have allowed that exact AI here; the group's
 * consent for people does not extend to AIs. Stops need no consent.
 */
export function groupAiCommandRefusal(
  accountId: string | null,
  roomId: string | null,
  isDm: boolean,
  agentId: string,
  groupAgentIds: readonly string[],
  action: CmdAction,
): string | null {
  if (!GROUP_AI_ACTIONS.includes(action)) return '不支持这个操作';
  if (STOP_ACTIONS.includes(action)) return null;
  if (isDm || !roomId || !groupAgentIds.includes(agentId)) return '这个 AI 不在当前群里';
  if (!groupAiDeviceAccess(accountId, roomId, agentId)) return '对方没有允许这个 AI 控制设备';
  return null;
}
