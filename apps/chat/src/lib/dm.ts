/**
 * Direct messages, client side.
 *
 * Two services answer two different questions and neither can answer the other's. The
 * account service says who you may talk to and where the conversation lives (a signed
 * ticket); Chat's Worker says what is in it. This module is the seam, plus the one piece
 * of state that is nobody's business but this browser's: how far you have read.
 *
 * **Nothing here throws and nothing here requires an account to be *called*.** The
 * sidebar polls it, the sidebar is mounted for signed-out users too, and anonymous use of
 * Chat is a hard constraint — so a 401 and an unreachable Worker both have to come back
 * as an empty list.
 */

import { apiBaseUrl } from '@0xnullai/settings';
import { dmConversations, type DmConversation } from '@0xnullai/auth';

/** One conversation's state as Chat's Worker reports it. */
export interface DmSummary {
  room: string;
  lastTs: number;
  unread: number;
}

/** A row in the sidebar: who, when, and how much of it you have not seen. */
export interface DmListEntry {
  peer: DmConversation;
  /** Newest message in the conversation, or 0 for one nothing has been said in yet. */
  lastTs: number;
  unread: number;
}

/**
 * Where you have read up to, per conversation.
 *
 * Local on purpose. It is a per-device convenience, not a fact about the conversation,
 * and putting it on the server would mean the account service learning when you read
 * whose messages — which is most of what it would need to reconstruct the conversation
 * it deliberately never sees. The cost is that read state does not follow you to another
 * device; the badge being wrong on a second phone is a small price for that.
 *
 * The key follows the existing convention (`dg-chat-name`, `dg-chat-groups`).
 */
const READ_KEY = 'dg-chat-dm-read';

type ReadState = Record<string, number>;

export function loadDmRead(): ReadState {
  try {
    const raw = localStorage.getItem(READ_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ReadState = {};
    for (const [room, ts] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof ts === 'number' && Number.isFinite(ts)) out[room] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Mark a conversation read up to `ts`.
 *
 * Monotonic: a lower timestamp is ignored rather than rewinding the mark. Reconnecting
 * replays the whole retained history, and the last message of that replay can be older
 * than what was already on screen — letting it move the mark backwards would resurrect a
 * badge for messages the user has already read.
 */
export function markDmRead(room: string, ts: number): void {
  if (!room || !Number.isFinite(ts)) return;
  const state = loadDmRead();
  if ((state[room] ?? 0) >= ts) return;
  state[room] = ts;
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked; the badge is a convenience, not a source of truth */
  }
}

/**
 * Ask Chat's Worker for unread counts.
 *
 * The ticket is what bounds this: it names the conversations the account service just
 * confirmed you are party to, and the Worker answers for no others. `since` only makes
 * the numbers it returns bigger or smaller — it grants nothing.
 */
export async function fetchDmDigest(
  ticket: string,
  since: Record<string, number>,
): Promise<DmSummary[]> {
  try {
    const res = await fetch(`${apiBaseUrl()}/api/dm/digest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, since }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { conversations?: DmSummary[] };
    return data.conversations ?? [];
  } catch {
    return [];
  }
}

/**
 * Build the sidebar list.
 *
 * Most-recent-first, with a conversation nothing has been said in yet falling back to
 * when it was opened — otherwise starting a conversation would file it at the bottom,
 * below everything, which is the opposite of where the person who just started it is
 * looking.
 */
export function mergeDmList(
  conversations: DmConversation[],
  summaries: DmSummary[],
): DmListEntry[] {
  const byRoom = new Map(summaries.map((s) => [s.room, s]));
  return conversations
    .map((peer) => {
      const summary = byRoom.get(peer.room);
      return {
        peer,
        lastTs: summary?.lastTs ?? 0,
        unread: summary?.unread ?? 0,
      };
    })
    .sort((a, b) => (b.lastTs || b.peer.startedAt) - (a.lastTs || a.peer.startedAt));
}

/**
 * The whole list, in one call: re-authorize with the account service, then ask Chat what
 * is in the conversations it named.
 *
 * Null means "there is nothing to show" — signed out, or one of the two services is
 * unreachable — and the caller renders no DM affordances at all rather than an empty
 * section that implies the feature is broken.
 */
export async function loadDmList(): Promise<DmListEntry[] | null> {
  const list = await dmConversations();
  if (!list) return null;
  if (list.conversations.length === 0) return [];
  const read = loadDmRead();
  const since: Record<string, number> = {};
  for (const c of list.conversations) since[c.room] = read[c.room] ?? 0;
  return mergeDmList(list.conversations, await fetchDmDigest(list.ticket, since));
}
