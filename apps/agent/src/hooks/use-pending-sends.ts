import { useState, useSyncExternalStore } from 'react';

const REPLY_ABORTED_ERROR_MESSAGE = '已停止当前回复';

/**
 * Sends this page started and that have not settled, per conversation.
 *
 * A send does network work (scene binding, history snapshot, server run allocation) before the
 * runtime knows about the turn. Each one gets its own AbortController from the moment the user
 * presses send, so a stop in that window is latched instead of silently missed, and one running
 * conversation never marks another one busy.
 */
export class PendingSends {
  private readonly sends = new Map<string, Set<AbortController>>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlySet<string> = new Set();

  begin(sessionId: string): AbortController {
    const controller = new AbortController();
    const set = this.sends.get(sessionId) ?? new Set<AbortController>();
    set.add(controller);
    this.sends.set(sessionId, set);
    this.publish();
    return controller;
  }

  end(sessionId: string, controller: AbortController): void {
    const set = this.sends.get(sessionId);
    if (!set?.delete(controller)) return;
    if (set.size === 0) this.sends.delete(sessionId);
    this.publish();
  }

  /** Abort one conversation's sends, or every send when no id is given. */
  abort(sessionId?: string): void {
    const sets = sessionId === undefined ? [...this.sends.values()] : [this.sends.get(sessionId)];
    for (const set of sets) for (const controller of set ?? []) controller.abort();
  }

  has(sessionId: string | null): boolean {
    return sessionId !== null && this.sends.has(sessionId);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReadonlySet<string> => this.snapshot;

  private publish(): void {
    this.snapshot = new Set(this.sends.keys());
    for (const listener of this.listeners) listener();
  }
}

/** Throws the reply-aborted error the UI already treats as a user stop. */
export function throwIfSendAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(REPLY_ABORTED_ERROR_MESSAGE);
}

export function usePendingSends(): { pendingSends: PendingSends; pendingIds: ReadonlySet<string> } {
  const [pendingSends] = useState(() => new PendingSends());
  const pendingIds = useSyncExternalStore(pendingSends.subscribe, pendingSends.getSnapshot);
  return { pendingSends, pendingIds };
}
