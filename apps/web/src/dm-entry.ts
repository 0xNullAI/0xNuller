/**
 * The profile's way into a conversation.
 *
 * This file was written as a stub while direct messages were built on a
 * separate branch; both have now landed, so it is a one-function adapter onto
 * the real implementation rather than a placeholder. It stays because it is
 * the only place the profile knows anything about how a conversation opens —
 * `ProfileDialog` imports from here and nowhere else.
 *
 * Two things are deliberately *not* here:
 *
 * - **Who may start a conversation.** That is mutual-follow, decided by
 *   `canDirectMessage` in `@0xnullai/auth`, and enforced again server-side
 *   when the ticket is minted. This module is reached only after the client
 *   side of that has already said yes, and it is not the thing keeping anyone
 *   out.
 * - **Any UI.** No dialog, no toast. `openDirectMessage` navigates to Chat and
 *   hands over the request; Chat renders it.
 *
 * The parameter is an **account id**, not a username: a conversation is with
 * an account and has to survive the other person renaming themselves.
 */

import { openDirectMessage as openConversation } from '@0xnullai/auth';

/** Open a conversation with this account. */
export function openDirectMessage(accountId: string): void {
  openConversation(accountId);
}
