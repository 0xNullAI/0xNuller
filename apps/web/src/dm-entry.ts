/**
 * ============================================================================
 * SEAM — direct messages. Replacing this is a one-line change.
 * ============================================================================
 *
 * Direct messaging is being built separately and will export something of the
 * shape `openDirectMessage(accountId: string)`. It does not exist yet, so this
 * module stands in for it: the profile's 「私聊」 button calls
 * `openDirectMessage` from here and nothing else in the profile knows how a
 * conversation is opened.
 *
 * **To wire up the real implementation**, replace the body of
 * `openDirectMessage` below with a call into it:
 *
 *     import { openDirectMessage as open } from '<wherever it lands>';
 *     export function openDirectMessage(accountId: string): DirectMessageResult {
 *       open(accountId);
 *       return { opened: true };
 *     }
 *
 * and delete `isDirectMessageReady` along with its call site in ProfileView —
 * the button stops needing an "not available yet" state once there is
 * something behind it.
 *
 * Two things are deliberately *not* here, because they are the profile's job
 * and would have to be re-implemented if this file grew them:
 *
 * - **Who may start a conversation.** That is mutual-follow, decided by
 *   `canDirectMessage` in `@0xnullai/auth`. This module is reached only after
 *   that has already said yes.
 * - **Any UI.** No dialog, no toast. The caller renders the disabled state
 *   from `isDirectMessageReady()`, so the seam stays a plain function.
 *
 * The parameter is an **account id**, not a username: a conversation is with an
 * account and has to survive the other person renaming themselves.
 */

export interface DirectMessageResult {
  /** Whether a conversation was actually opened. False while the seam is a stub. */
  opened: boolean;
}

/**
 * Is there a real direct-message implementation behind the seam yet?
 *
 * Exists so the button can be present and explain itself rather than be hidden.
 * Hiding it would make the mutual-follow gate — the thing this product wants
 * people to understand — invisible until the day the feature lands.
 */
export function isDirectMessageReady(): boolean {
  return false;
}

/** Open a conversation with this account. See the note at the top of the file. */
export function openDirectMessage(_accountId: string): DirectMessageResult {
  return { opened: false };
}
