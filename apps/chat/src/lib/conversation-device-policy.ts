import { deviceConversationAccess } from '@0xnullai/settings';
import type { CmdAction } from './protocol';

/** Consent is an additional gate; it grants neither a lease nor a physical target. */
export function chatConversationAllowsCommand(
  accountId: string | null,
  roomId: string | null,
  isDm: boolean,
  action: CmdAction,
): boolean {
  // Output-reducing preemption remains reachable after revocation or loss of a lease.
  if (['stop', 'stop_wave', 'vibrate_stop', 'fire_release'].includes(action)) return true;
  return !!roomId && deviceConversationAccess(accountId, isDm ? 'dm' : 'group', roomId);
}
