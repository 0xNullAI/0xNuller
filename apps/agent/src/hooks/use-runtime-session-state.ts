import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import type { AgentClient } from '@dg-agent/client';
import { getObservedConversationSequence } from '@dg-agent/storage-browser';
import {
  createEmptyDeviceState,
  type DeviceState,
  type RuntimeEvent,
  type SessionSnapshot,
} from '@dg-agent/core';
import { buildLiveTraceFeedItemFromEvent, type TraceFeedItem } from '../utils/trace-feed.js';

// Toast detection keeps the most recent in-flight events; older entries
// don't matter and would only inflate memory. Cap matches the previous
// implementation but the array is no longer persisted across reloads.
const RECENT_EVENT_BUFFER = 200;

// Device action notes stay with their conversation until it is left; a long session
// must not grow them without bound.
const LIVE_TRACE_LIMIT = 200;

const LEGACY_EVENT_LOG_KEY = 'dg-agent.event-log';

function dropLegacyEventLog(): void {
  try {
    localStorage.removeItem(LEGACY_EVENT_LOG_KEY);
  } catch {
    // ignore
  }
}

export interface UseRuntimeSessionStateOptions {
  client: AgentClient;
  enabled: boolean;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  onError?: (message: string) => void;
  onAccountChange?: () => void;
}

export function isActiveRuntimeSessionEvent(event: RuntimeEvent, sessionId: string): boolean {
  return !('sessionId' in event) || event.sessionId === sessionId;
}

function isTurnEndEvent(event: RuntimeEvent): boolean {
  return (
    event.type === 'assistant-message-completed' ||
    event.type === 'assistant-message-aborted' ||
    event.type === 'assistant-message-failed'
  );
}

export function shouldClearStreamingForEvent(event: RuntimeEvent): boolean {
  return event.type === 'session-updated' || isTurnEndEvent(event);
}

/** Events that only happen while a reply for that session is running. */
export function isReplyActivityEvent(event: RuntimeEvent): boolean {
  return (
    event.type === 'user-message-accepted' ||
    event.type === 'assistant-message-delta' ||
    event.type.startsWith('tool-call-')
  );
}

export function shouldRefreshSessionForEvent(event: RuntimeEvent): boolean {
  return (
    event.type === 'user-message-accepted' ||
    event.type === 'session-updated' ||
    isTurnEndEvent(event)
  );
}

export function appendAcceptedUserMessage(
  current: SessionSnapshot | null,
  sessionId: string,
  message: SessionSnapshot['messages'][number],
): SessionSnapshot | null {
  if (!current || current.id !== sessionId) return current;
  if (current.messages.some((existing) => existing.id === message.id)) return current;
  return {
    ...current,
    updatedAt: message.createdAt,
    messages: [...current.messages, { ...message, serverConfirmed: false }],
  };
}

/** Only a completed account-bound server read may mark a display row saved. */
export function markServerDisplaySnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    messages: snapshot.messages.map((message) => ({ ...message, serverConfirmed: true })),
  };
}

/**
 * Keep already viewed pages while a fresh bounded server window arrives. The fresh window is
 * authoritative and keeps its server order; rows it does not contain (older pages, or a user
 * message the server has not echoed yet) are merged in by time instead of being stacked in
 * front of it.
 */
export function mergeDisplaySnapshot(
  previous: SessionSnapshot | null,
  next: SessionSnapshot,
): SessionSnapshot {
  if (!previous || previous.id !== next.id || !previous.historyWindow || !next.historyWindow)
    return next;
  const freshIds = new Set(next.messages.map((message) => message.id));
  const kept = previous.messages.filter((message) => !freshIds.has(message.id));
  const messages: SessionSnapshot['messages'] = [];
  let k = 0;
  for (const message of next.messages) {
    while (k < kept.length && kept[k]!.createdAt < message.createdAt) messages.push(kept[k++]!);
    messages.push(message);
  }
  while (k < kept.length) messages.push(kept[k++]!);
  const previousBefore = previous.historyWindow.nextBefore;
  const nextBefore = next.historyWindow.nextBefore;
  return {
    ...next,
    messages,
    historyWindow: {
      nextBefore:
        previousBefore === null || nextBefore === null
          ? null
          : Math.min(previousBefore, nextBefore),
    },
  };
}

/** A server sequence above the one this screen was rendered from means unseen messages. */
export function hasNewerServerMessages(remote: unknown, local: number | null): boolean {
  return typeof remote === 'number' && local !== null && remote > local;
}

export function useRuntimeSessionState(options: UseRuntimeSessionStateOptions) {
  const { client, enabled, onRuntimeEvent } = options;
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);
  // Mirrors activeSessionId synchronously, so a read that finishes after the user moved to
  // another conversation can tell and is dropped instead of showing the wrong conversation.
  const activeSessionIdRef = useRef<string | null>(null);
  const setActiveSessionId = useCallback<Dispatch<SetStateAction<string | null>>>((value) => {
    const next = typeof value === 'function' ? value(activeSessionIdRef.current) : value;
    activeSessionIdRef.current = next;
    setActiveSessionIdState(next);
  }, []);
  const [events, setEvents] = useState<RuntimeEvent[]>(() => {
    dropLegacyEventLog();
    return [];
  });
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [savedSessions, setSavedSessions] = useState<SessionSnapshot[]>([]);
  const [liveDeviceState, setLiveDeviceState] = useState<DeviceState>(createEmptyDeviceState());
  const [replyBusy, setReplyBusy] = useState(false);
  // Conversations with a reply running, whoever started it (this page, a sensor or a
  // timer), so the stop button follows the conversation on screen.
  const runningRepliesRef = useRef(new Set<string>());
  const [streamingAssistantText, setStreamingAssistantText] = useState('');
  // Page-only notice for the last failed reply; it is never part of the session record.
  const [failedReply, setFailedReply] = useState<{ sessionId: string; text: string } | null>(null);
  const [liveTraceItems, setLiveTraceItems] = useState<TraceFeedItem[]>([]);
  const onRuntimeEventRef = useRef(onRuntimeEvent);
  // One counter for every display read: only the newest read may land, so a slow older read
  // can never overwrite a newer one or interleave its rows.
  const syncRequestIdRef = useRef(0);
  const accountGenerationRef = useRef(0);
  const accountIdRef = useRef(currentAuthUserId());
  const onAccountChangeRef = useRef(options.onAccountChange);
  onAccountChangeRef.current = options.onAccountChange;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const reportError = useCallback((error: unknown) => {
    onErrorRef.current?.(error instanceof Error ? error.message : '会话服务暂不可用，请重试。');
  }, []);
  useEffect(() => {
    const handler = (event: Event) => onErrorRef.current?.(String((event as CustomEvent).detail));
    window.addEventListener('0xnullai:conversation-warning', handler);
    return () => window.removeEventListener('0xnullai:conversation-warning', handler);
  }, []);

  useEffect(() => {
    onRuntimeEventRef.current = onRuntimeEvent;
  }, [onRuntimeEvent]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const clearStreamingAssistantText = useCallback(() => {
    setStreamingAssistantText('');
  }, []);

  const savedSessionsReadRef = useRef<CoalescedRead | null>(null);
  const refreshSavedSessions = useCallback(async (): Promise<void> => {
    const generation = accountGenerationRef.current;
    await coalesce(savedSessionsReadRef, async () => {
      const sessions = await client.listSessions();
      if (generation === accountGenerationRef.current) setSavedSessions(sessions);
    });
  }, [client]);

  const sessionReadRef = useRef<CoalescedSessionRead | null>(null);
  /**
   * Re-read the open conversation. Reads that overlap join the one in flight (which then runs
   * once more), so a burst of events costs at most two reads; the navigation list is only read
   * when asked, since most events of the open conversation do not change it.
   */
  const readSession = useCallback(
    async (sessionId: string, withList: boolean): Promise<void> => {
      if (sessionId !== activeSessionIdRef.current) return;
      const inFlight = sessionReadRef.current;
      if (inFlight && inFlight.sessionId === sessionId) {
        inFlight.again = true;
        inFlight.withList ||= withList;
        return inFlight.promise;
      }
      const generation = accountGenerationRef.current;
      const read: CoalescedSessionRead = {
        sessionId,
        again: false,
        withList,
        promise: Promise.resolve(),
      };
      read.promise = (async () => {
        try {
          do {
            read.again = false;
            const listNow = read.withList;
            read.withList = false;
            const requestId = ++syncRequestIdRef.current;
            const [currentSession, sessions] = await Promise.all([
              client.getSessionDisplaySnapshot(sessionId),
              listNow ? client.listSessions() : null,
            ]);
            if (
              generation !== accountGenerationRef.current ||
              requestId !== syncRequestIdRef.current ||
              sessionId !== activeSessionIdRef.current
            )
              return;
            setSession((previous) =>
              mergeDisplaySnapshot(previous, markServerDisplaySnapshot(currentSession)),
            );
            if (sessions) setSavedSessions(sessions);
            setLiveDeviceState(currentSession.deviceState);
          } while (read.again);
        } finally {
          if (sessionReadRef.current === read) sessionReadRef.current = null;
        }
      })();
      sessionReadRef.current = read;
      return read.promise;
    },
    [client],
  );

  const refreshCurrentSession = useCallback(
    async (sessionId = activeSessionIdRef.current): Promise<void> => {
      if (!sessionId) return;
      await readSession(sessionId, true);
    },
    [readSession],
  );

  const loadOlderSessionMessages = useCallback(
    async (sessionId: string, before: number) => {
      const generation = accountGenerationRef.current;
      const page = await client.getSessionMessagesPage(sessionId, before);
      if (generation !== accountGenerationRef.current) return;
      setSession((current) => {
        if (!current || current.id !== sessionId || current.historyWindow?.nextBefore !== before)
          return current;
        const known = new Set(current.messages.map((message) => message.id));
        return {
          ...current,
          messages: [
            ...page.items
              .filter((message) => !known.has(message.id))
              .map(({ sequence: _sequence, ...message }) => ({
                ...message,
                serverConfirmed: true,
              })),
            ...current.messages,
          ],
          historyWindow: { nextBefore: page.nextBefore },
        };
      });
    },
    [client],
  );

  // The shell reports each AI conversation's latest server sequence. A higher one for the
  // open conversation means a message arrived from elsewhere (a scheduled AI message or
  // another device); show it without a reload, but never in the middle of a reply.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const replyBusyRef = useRef(replyBusy);
  replyBusyRef.current = replyBusy;
  useEffect(() => {
    if (!enabled) return;
    const sequences = (event: Event) => {
      const detail = (
        event as CustomEvent<{ accountId: string | null; sequences: Record<string, number> }>
      ).detail;
      const account = currentAuthUserId();
      if (!account || detail?.accountId !== account || !activeSessionId || replyBusyRef.current)
        return;
      if (
        hasNewerServerMessages(
          detail.sequences?.[activeSessionId],
          getObservedConversationSequence(sessionRef.current, account),
        )
      )
        void refreshCurrentSession().catch(reportError);
    };
    window.addEventListener('0xnullai:conversation-sequences', sequences);
    return () => window.removeEventListener('0xnullai:conversation-sequences', sequences);
  }, [activeSessionId, enabled, refreshCurrentSession, reportError]);

  useEffect(() => {
    if (!enabled) return;
    const saved = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId: string; conversationId: string }>).detail;
      if (detail?.accountId !== currentAuthUserId()) return;
      if (detail.conversationId === activeSessionId)
        void refreshCurrentSession().catch(reportError);
      else void refreshSavedSessions().catch(reportError);
    };
    window.addEventListener('0xnullai:conversation-saved', saved);
    return () => window.removeEventListener('0xnullai:conversation-saved', saved);
  }, [activeSessionId, enabled, refreshCurrentSession, refreshSavedSessions, reportError]);

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    const generation = accountGenerationRef.current;

    async function bootstrap(): Promise<void> {
      const sessions = await client.listSessions();
      if (!active || generation !== accountGenerationRef.current) return;

      setSavedSessions(sessions);
      const firstId = sessions[0]?.id;
      if (firstId) {
        setActiveSessionId((current) => current ?? firstId);
      } else {
        const newId = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        setActiveSessionId((current) => current ?? newId);
      }
    }

    void bootstrap().catch((error) => {
      if (active && generation === accountGenerationRef.current) reportError(error);
    });

    return () => {
      active = false;
    };
  }, [client, enabled, reportError, setActiveSessionId]);

  // The Agent module can stay mounted behind another tab while the account is
  // changed in the shell. Re-read the account-partitioned store immediately so
  // one account's conversation list is never left on screen for the next one.
  useEffect(() => {
    if (!enabled) return;
    return subscribeAuthChanges(() => {
      const nextAccount = currentAuthUserId();
      if (nextAccount === accountIdRef.current) return;
      accountIdRef.current = nextAccount;
      const generation = ++accountGenerationRef.current;
      syncRequestIdRef.current++;
      onAccountChangeRef.current?.();
      void client.emergencyStop(activeSessionId ?? 'account-change').catch(reportError);
      setActiveSessionId(null);
      setSession(null);
      setSavedSessions([]);
      setEvents([]);
      setLiveTraceItems([]);
      setStreamingAssistantText('');
      runningRepliesRef.current.clear();
      setReplyBusy(false);
      void client
        .listSessions()
        .then((sessions) => {
          if (generation !== accountGenerationRef.current) return;
          setSavedSessions(sessions);
          const firstId = sessions[0]?.id ?? null;
          setActiveSessionId(firstId ?? `session-${Date.now().toString(36)}`);
          if (!firstId) setSession(null);
        })
        .catch((error) => {
          if (generation === accountGenerationRef.current) reportError(error);
        });
    });
  }, [client, enabled, activeSessionId, reportError, setActiveSessionId]);

  useEffect(() => {
    if (!enabled || !activeSessionId) return;

    let active = true;
    const sessionId = activeSessionId;
    const generation = accountGenerationRef.current;
    // A reply already running here (started by a sensor or timer) keeps its stop
    // button; device notes from the conversation just left do not follow.
    setReplyBusy(
      runningRepliesRef.current.has(sessionId) || client.isReplyRunning?.(sessionId) === true,
    );
    setLiveTraceItems([]);

    const syncCurrentSession = (withList: boolean) => readSession(sessionId, withList);

    void syncCurrentSession(true).catch((error) => {
      if (active && generation === accountGenerationRef.current) reportError(error);
    });

    const unsubscribe = client.subscribe((event) => {
      if (generation !== accountGenerationRef.current) return;
      // Device state is a reading, not a conversation event: keep it out of the event log,
      // and re-render only when the reading actually changed.
      if (event.type === 'device-state-changed') {
        setLiveDeviceState((current) =>
          sameShallow(current, event.state) ? current : event.state,
        );
        return;
      }
      setEvents((current) => [event, ...current].slice(0, RECENT_EVENT_BUFFER));

      const isActiveSessionEvent = isActiveRuntimeSessionEvent(event, sessionId);
      if ('sessionId' in event && event.sessionId) {
        if (isReplyActivityEvent(event)) runningRepliesRef.current.add(event.sessionId);
        if (isTurnEndEvent(event)) runningRepliesRef.current.delete(event.sessionId);
      }

      if (isActiveSessionEvent && event.type === 'user-message-accepted') {
        setFailedReply(null);
        setReplyBusy(true);
        // The runtime has already persisted this exact message before emitting.
        // Render it from the event immediately instead of waiting for an IndexedDB
        // round trip; the subsequent snapshot refresh remains authoritative.
        setSession((current) => appendAcceptedUserMessage(current, sessionId, event.message));
      }

      if (isActiveSessionEvent) {
        const liveItem = buildLiveTraceFeedItemFromEvent(event);
        if (liveItem) {
          setLiveTraceItems((current) => [...current, liveItem].slice(-LIVE_TRACE_LIMIT));
        }
      }

      if (event.type === 'assistant-message-delta') {
        if (isActiveSessionEvent) {
          setReplyBusy(true);
          setStreamingAssistantText(event.content);
          onRuntimeEventRef.current?.(event);
        }
        return;
      }

      if (event.type === 'device-command-executed') {
        setLiveDeviceState(event.result.state);
      }

      if (isActiveSessionEvent && isReplyActivityEvent(event)) {
        setReplyBusy(true);
      }

      if (isActiveSessionEvent && isTurnEndEvent(event)) {
        setReplyBusy(false);
      }

      if (isActiveSessionEvent && event.type === 'assistant-message-failed') {
        setFailedReply({ sessionId, text: event.message.content });
      }

      if (isActiveSessionEvent && shouldClearStreamingForEvent(event)) {
        setStreamingAssistantText('');
      }

      if (isTurnEndEvent(event)) {
        setStreamingAssistantText('');
      }

      if (isActiveSessionEvent) {
        onRuntimeEventRef.current?.(event);
      }

      if (shouldRefreshSessionForEvent(event)) {
        if (isActiveSessionEvent) {
          // Only the end of a turn changes the navigation list (title, order, preview).
          void syncCurrentSession(isTurnEndEvent(event)).catch((error) => {
            if (active && generation === accountGenerationRef.current) reportError(error);
          });
        } else {
          void refreshSavedSessions().catch(reportError);
        }
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeSessionId, client, enabled, readSession, refreshSavedSessions, reportError]);

  return {
    activeSessionId,
    setActiveSessionId,
    events,
    clearEvents,
    session,
    setSession,
    savedSessions,
    setSavedSessions,
    liveDeviceState,
    replyBusy,
    streamingAssistantText,
    failedReplyText: failedReply?.sessionId === activeSessionId ? failedReply.text : '',
    clearStreamingAssistantText,
    setStreamingAssistantText,
    liveTraceItems,
    refreshCurrentSession,
    loadOlderSessionMessages,
  };
}

function sameShallow<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys)
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  return true;
}

interface CoalescedRead {
  again: boolean;
  promise: Promise<void>;
}

interface CoalescedSessionRead extends CoalescedRead {
  sessionId: string;
  withList: boolean;
}

/** Run `read`, or, while one is in flight, ask it to run once more and share its promise. */
function coalesce(
  ref: { current: CoalescedRead | null },
  read: () => Promise<void>,
): Promise<void> {
  if (ref.current) {
    ref.current.again = true;
    return ref.current.promise;
  }
  const entry: CoalescedRead = { again: false, promise: Promise.resolve() };
  entry.promise = (async () => {
    try {
      do {
        entry.again = false;
        await read();
      } while (entry.again);
    } finally {
      if (ref.current === entry) ref.current = null;
    }
  })();
  ref.current = entry;
  return entry.promise;
}
