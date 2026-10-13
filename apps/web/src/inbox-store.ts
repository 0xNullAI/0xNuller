import { useEffect, useSyncExternalStore } from 'react';
import {
  currentAuthUserId,
  listPrivateConversationSummaries,
  subscribeAuthChanges,
  type PrivateConversationSummary,
} from '@0xnullai/auth';
import { loadChatInboxDisplayWithStatus, type ChatInboxEntry } from '../../chat/src/inbox';

/**
 * The one copy of the conversation list, shared by the unread badge and the inbox.
 *
 * The badge (mounted on every page) and the inbox list (sidebar or phone home) used to
 * poll the same AI and human-chat endpoints on their own 30 s timers, hidden tab or not,
 * and the desktop sidebar threw its rows away whenever the user left Agent/Chat — coming
 * back meant a skeleton until the slowest source answered. Now both read this store:
 *
 * - one poller while anything is subscribed: every 30 s while the page is visible, every
 *   2 min while it is hidden (still enough for the background unread notification);
 * - the AI and human sources land independently, so AI rows show as soon as they arrive
 *   instead of waiting for the group-chat chain;
 * - rows survive unmounting, so a remounted inbox shows them at once and refreshes behind;
 * - an account whose email is unverified never asks the human-chat endpoints, which
 *   would only refuse it.
 *
 * Every response is fenced by an epoch and the live account id, so a late answer for a
 * previous account never lands in the next one's list.
 */

const VISIBLE_POLL_MS = 30_000;
const HIDDEN_POLL_MS = 120_000;
const DEBOUNCE_MS = 300;
/** A remounted list older than this refreshes in the background while showing the cache. */
const REMOUNT_STALE_MS = 10_000;
const AI_PAGE_SIZE = 100;
const CONVERSATION_SEQUENCES_EVENT = '0xnullai:conversation-sequences';

export interface InboxAiState {
  items: PrivateConversationSummary[];
  nextCursor: string | null;
  /** The first answer (success or failure) for this account has arrived. */
  settled: boolean;
  /** The latest refresh failed; `items` are the last verified ones. */
  failed: boolean;
}

export interface InboxHumanState {
  entries: ChatInboxEntry[];
  /** Entries carried over from an earlier load that this refresh could not re-verify. */
  staleIds: ReadonlySet<string>;
  settled: boolean;
  failed: boolean;
  partialError: string | null;
  nextGroupCursor: string | null;
  groupPageFailed: boolean;
}

export interface InboxSnapshot {
  accountId: string | null;
  humanLocked: boolean;
  ai: InboxAiState;
  human: InboxHumanState;
  /** Row ids that appeared on a refresh after the first load; only these animate in. */
  fresh: ReadonlySet<string>;
  groupPages: number;
  loadingMoreAi: boolean;
  loadingMoreGroups: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function emptySnapshot(accountId: string | null, humanLocked: boolean): InboxSnapshot {
  return {
    accountId,
    humanLocked,
    ai: { items: [], nextCursor: null, settled: false, failed: false },
    human: {
      entries: [],
      staleIds: EMPTY_SET,
      // Nothing to wait for when the account may not use human chat.
      settled: humanLocked,
      failed: false,
      partialError: null,
      nextGroupCursor: null,
      groupPageFailed: false,
    },
    fresh: EMPTY_SET,
    groupPages: 1,
    loadingMoreAi: false,
    loadingMoreGroups: false,
  };
}

let snapshot: InboxSnapshot = emptySnapshot(null, false);
let epoch = 0;
let aiPages = 1;
let aiRequest = 0;
let humanRequest = 0;
let lastLoadedAt = 0;
let subscribers = 0;
let pollTimer: number | null = null;
let debounceTimer: number | null = null;
let stopWatchingAuth: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(next: InboxSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function aiRowId(item: PrivateConversationSummary): string {
  return `ai:${item.id}`;
}

function freshIds(
  previous: readonly string[],
  next: readonly string[],
  firstLoad: boolean,
): ReadonlySet<string> {
  if (firstLoad) return EMPTY_SET;
  const known = new Set(previous);
  const added = next.filter((id) => !known.has(id));
  return added.length ? new Set(added) : EMPTY_SET;
}

function live(requestEpoch: number, accountId: string): boolean {
  return requestEpoch === epoch && currentAuthUserId() === accountId;
}

async function loadAiPages(accountId: string, pageCount: number) {
  const items: PrivateConversationSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < pageCount; page++) {
    if (currentAuthUserId() !== accountId) throw new Error('账户已切换');
    const result = await listPrivateConversationSummaries({
      limit: AI_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of result.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    if (!result.nextCursor) return { items, nextCursor: null };
    cursor = result.nextCursor;
  }
  return { items, nextCursor: cursor ?? null };
}

/** Lets an open AI conversation pick up messages written elsewhere without its own poll. */
function announceSequences(accountId: string, items: readonly PrivateConversationSummary[]): void {
  const sequences: Record<string, number> = {};
  for (const item of items)
    if (!item.deleted && typeof item.lastSequence === 'number')
      sequences[item.id] = item.lastSequence;
  window.dispatchEvent(
    new CustomEvent(CONVERSATION_SEQUENCES_EVENT, { detail: { accountId, sequences } }),
  );
}

function refreshAi(accountId: string, requestEpoch: number): Promise<void> {
  const request = ++aiRequest;
  return loadAiPages(accountId, aiPages).then(
    (result) => {
      if (!live(requestEpoch, accountId) || request !== aiRequest) return;
      announceSequences(accountId, result.items);
      const previous = snapshot.ai;
      emit({
        ...snapshot,
        ai: { items: result.items, nextCursor: result.nextCursor, settled: true, failed: false },
        fresh: freshIds(
          previous.items.map(aiRowId),
          result.items.map(aiRowId),
          !previous.settled || previous.failed,
        ),
      });
    },
    () => {
      if (!live(requestEpoch, accountId) || request !== aiRequest) return;
      // Keep the last verified rows; the list shows them as unconfirmed.
      emit({
        ...snapshot,
        ai: { ...snapshot.ai, nextCursor: null, settled: true, failed: true },
      });
    },
  );
}

function refreshHuman(accountId: string, requestEpoch: number): Promise<void> {
  if (snapshot.humanLocked) return Promise.resolve();
  const request = ++humanRequest;
  const pages = snapshot.groupPages;
  return loadChatInboxDisplayWithStatus(pages).then(
    (result) => {
      if (!live(requestEpoch, accountId) || request !== humanRequest) return;
      const previous = snapshot.human;
      const entries = [...result.entries];
      const stale = new Set<string>();
      if (result.groupPageFailed || result.dmLoadFailed) {
        // A source that could not be re-verified keeps its last rows, marked as such,
        // rather than silently dropping conversations the person just saw.
        const seen = new Set(entries.map((entry) => entry.id));
        for (const entry of previous.entries) {
          const failed = entry.kind === 'group' ? result.groupPageFailed : result.dmLoadFailed;
          if (!failed || seen.has(entry.id)) continue;
          entries.push(entry);
          stale.add(entry.id);
        }
      }
      emit({
        ...snapshot,
        human: {
          entries,
          staleIds: stale.size ? stale : EMPTY_SET,
          settled: true,
          failed: false,
          partialError: result.partialError,
          nextGroupCursor: result.nextGroupCursor ?? null,
          groupPageFailed: Boolean(result.groupPageFailed),
        },
        fresh: freshIds(
          previous.entries.map((entry) => entry.id),
          result.entries.map((entry) => entry.id),
          !previous.settled || previous.failed,
        ),
        loadingMoreGroups: false,
      });
    },
    () => {
      if (!live(requestEpoch, accountId) || request !== humanRequest) return;
      const previous = snapshot.human;
      emit({
        ...snapshot,
        human: {
          ...previous,
          staleIds: new Set(previous.entries.map((entry) => entry.id)),
          settled: true,
          failed: true,
          groupPageFailed: true,
          nextGroupCursor: null,
        },
        loadingMoreGroups: false,
      });
    },
  );
}

/** Reload both sources now. Each one updates the list as soon as it answers. */
export function refreshInbox(): Promise<void> {
  const accountId = snapshot.accountId;
  if (!accountId || currentAuthUserId() !== accountId) return Promise.resolve();
  const requestEpoch = epoch;
  lastLoadedAt = Date.now();
  return Promise.all([
    refreshAi(accountId, requestEpoch),
    refreshHuman(accountId, requestEpoch),
  ]).then(() => undefined);
}

function scheduleRefresh(): void {
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void refreshInbox();
  }, DEBOUNCE_MS);
}

function schedulePoll(): void {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
  if (subscribers === 0 || !snapshot.accountId) return;
  const delay = document.visibilityState === 'hidden' ? HIDDEN_POLL_MS : VISIBLE_POLL_MS;
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    void refreshInbox();
    schedulePoll();
  }, delay);
}

function onVisibilityChange(): void {
  // Coming back to the tab refreshes at once; going away just slows the next poll.
  if (document.visibilityState === 'visible') scheduleRefresh();
  schedulePoll();
}

function startPolling(): void {
  window.addEventListener('focus', scheduleRefresh);
  window.addEventListener('0xnullai:conversation-updated', scheduleRefresh);
  document.addEventListener('visibilitychange', onVisibilityChange);
  stopWatchingAuth = subscribeAuthChanges(() => {
    // Hide the previous account's rows at once, before any component catches up.
    if (snapshot.accountId && currentAuthUserId() !== snapshot.accountId) resetAccount(null, false);
  });
  schedulePoll();
}

function stopPolling(): void {
  window.removeEventListener('focus', scheduleRefresh);
  window.removeEventListener('0xnullai:conversation-updated', scheduleRefresh);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopWatchingAuth?.();
  stopWatchingAuth = null;
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  pollTimer = null;
  debounceTimer = null;
}

function resetAccount(accountId: string | null, humanLocked: boolean): void {
  epoch++;
  aiPages = 1;
  lastLoadedAt = 0;
  emit(emptySnapshot(accountId, humanLocked));
}

/**
 * Point the store at the signed-in account. The id must match the live session; a stale
 * prop for an account that already signed out is treated as signed out.
 */
function configureInbox(accountId: string | null, humanLocked: boolean): void {
  const effective = accountId && currentAuthUserId() === accountId ? accountId : null;
  if (effective === snapshot.accountId && humanLocked === snapshot.humanLocked) return;
  if (effective !== snapshot.accountId) {
    resetAccount(effective, humanLocked);
  } else {
    // Verification state changed for the same account: drop or start the human source.
    emit({ ...snapshot, humanLocked, human: emptySnapshot(effective, humanLocked).human });
  }
  if (effective && subscribers > 0) {
    void refreshInbox();
    schedulePoll();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): InboxSnapshot {
  return snapshot;
}

/**
 * Subscribe to the shared conversation list for this account. Pass the signed-in user's
 * id and whether human chat is locked (unverified email); every caller passes the same.
 */
export function useInbox(accountId: string | null, humanLocked: boolean): InboxSnapshot {
  useEffect(() => {
    configureInbox(accountId, humanLocked);
  }, [accountId, humanLocked]);

  useEffect(() => {
    subscribers++;
    if (subscribers === 1) startPolling();
    // A first subscriber, or a list remounted over an old cache, refreshes behind the cache.
    if (snapshot.accountId && Date.now() - lastLoadedAt > REMOUNT_STALE_MS) void refreshInbox();
    return () => {
      subscribers--;
      if (subscribers === 0) stopPolling();
    };
  }, []);

  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return current.accountId === accountId ? current : emptySnapshot(accountId, humanLocked);
}

/** Fetch the next page of AI conversations and append it. */
export async function loadMoreAiConversations(): Promise<void> {
  const accountId = snapshot.accountId;
  const cursor = snapshot.ai.nextCursor;
  if (!accountId || !cursor || snapshot.loadingMoreAi) return;
  const requestEpoch = epoch;
  emit({ ...snapshot, loadingMoreAi: true });
  try {
    const page = await listPrivateConversationSummaries({ limit: AI_PAGE_SIZE, cursor });
    if (!live(requestEpoch, accountId)) return;
    aiPages += 1;
    const seen = new Set(snapshot.ai.items.map((item) => item.id));
    const items = [...snapshot.ai.items];
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    emit({
      ...snapshot,
      ai: {
        ...snapshot.ai,
        items,
        nextCursor: page.nextCursor && page.nextCursor !== cursor ? page.nextCursor : null,
      },
      loadingMoreAi: false,
    });
  } catch (error) {
    if (live(requestEpoch, accountId)) emit({ ...snapshot, loadingMoreAi: false });
    throw error;
  }
}

/** Show one more page of group chats, or retry the page that failed. */
export function loadMoreGroups(): Promise<void> {
  const accountId = snapshot.accountId;
  if (!accountId || snapshot.humanLocked || snapshot.loadingMoreGroups) return Promise.resolve();
  emit({
    ...snapshot,
    groupPages: snapshot.human.groupPageFailed ? snapshot.groupPages : snapshot.groupPages + 1,
    loadingMoreGroups: true,
  });
  return refreshHuman(accountId, epoch);
}

/** Test seam: forget everything between test cases. */
export function resetInboxStoreForTests(): void {
  stopPolling();
  subscribers = 0;
  aiRequest = 0;
  humanRequest = 0;
  resetAccount(null, false);
}
