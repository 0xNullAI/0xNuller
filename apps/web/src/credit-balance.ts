import { useEffect, useSyncExternalStore } from 'react';
import {
  currentAuthUserId,
  getCreditBalance,
  subscribeAuthChanges,
  type CreditBalance,
} from '@0xnullai/auth';

/**
 * The signed-in account's Credit balance, read by the nav rail, the settings overview
 * and the account page from one poller.
 *
 * Each of those used to run its own request loop — two of them every 15 s plus on every
 * focus and visibility change, hidden tab included. Now one loop runs while anything is
 * subscribed, pauses while the page is hidden, and refreshes once when it comes back.
 *
 * The balance is keyed by account id and follows the live session: after a sign-out, or
 * a sign-in as someone else, readers get null until the new account's own balance
 * arrives — never the previous person's number.
 */

const POLL_MS = 15_000;

let snapshot: { accountId: string; balance: CreditBalance | null } | null = null;
let request = 0;
let stopWatchingAuth: (() => void) | null = null;
let subscribers = 0;
let timer: number | null = null;
const listeners = new Set<() => void>();

function emit(next: typeof snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Re-read the balance now (after a purchase, or when the page comes back). */
export function refreshCreditBalance(): void {
  const owner = currentAuthUserId();
  if (!owner) return;
  const current = ++request;
  const live = () => current === request && currentAuthUserId() === owner;
  void getCreditBalance().then(
    (balance) => {
      if (live()) emit({ accountId: owner, balance });
    },
    () => {
      if (live()) emit({ accountId: owner, balance: null });
    },
  );
}

function tick(): void {
  if (document.visibilityState !== 'hidden') refreshCreditBalance();
}

function onVisible(): void {
  if (document.visibilityState === 'visible') refreshCreditBalance();
}

function onAccountChange(): void {
  // Drop the previous account's number at once and fetch the new one's.
  request++;
  emit(null);
  refreshCreditBalance();
}

function start(): void {
  timer = window.setInterval(tick, POLL_MS);
  window.addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);
  stopWatchingAuth = subscribeAuthChanges(onAccountChange);
}

function stop(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  window.removeEventListener('focus', onVisible);
  document.removeEventListener('visibilitychange', onVisible);
  stopWatchingAuth?.();
  stopWatchingAuth = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

/**
 * The balance for `owner` (the signed-in account), or null while unknown or signed out.
 * The store follows the session itself; `owner` only guards against showing a balance
 * that belongs to anyone other than the account this view is rendering for.
 */
export function useCreditBalance(owner: string | null): CreditBalance | null {
  useEffect(() => {
    subscribers++;
    if (subscribers === 1) start();
    // Every reader that appears gets a current number, as each page used to fetch on open.
    refreshCreditBalance();
    return () => {
      subscribers--;
      if (subscribers === 0) stop();
    };
  }, []);

  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return owner && current?.accountId === owner ? current.balance : null;
}

/** Test seam: forget the balance and the poller between test cases. */
export function resetCreditBalanceForTests(): void {
  stop();
  subscribers = 0;
  request++;
  snapshot = null;
}
