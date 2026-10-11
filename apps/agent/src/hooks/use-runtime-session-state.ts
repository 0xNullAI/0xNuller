import { useCallback, useEffect, useRef, useState } from 'react';
import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import type { AgentClient } from '@dg-agent/client';
import { getObservedConversationSequence } from '@dg-agent/storage-browser';
import {
  createEmptyDeviceState,
  type DeviceState,
  type RuntimeEvent,
  type RuntimeTraceEntry,
  type SessionSnapshot,
} from '@dg-agent/core';
import { buildLiveTraceFeedItemFromEvent, type TraceFeedItem } from '../utils/trace-feed.js';

// Toast detection keeps the most recent in-flight events; older entries
// don't matter and would only inflate memory. Cap matches the previous
// implementation but the array is no longer persisted across reloads.
const RECENT_EVENT_BUFFER = 200;

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

export function shouldClearStreamingForEvent(event: RuntimeEvent): boolean {
  return (
    event.type === 'session-updated' ||
    event.type === 'assistant-message-completed' ||
    event.type === 'assistant-message-aborted'
  );
}

export function shouldRefreshSessionForEvent(event: RuntimeEvent): boolean {
  return (
    event.type === 'user-message-accepted' ||
    event.type === 'session-updated' ||
    event.type === 'assistant-message-completed' ||
    event.type === 'assistant-message-aborted'
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

/** Keep already viewed pages while a fresh bounded server window arrives. */
export function mergeDisplaySnapshot(
  previous: SessionSnapshot | null,
  next: SessionSnapshot,
): SessionSnapshot {
  if (!previous || previous.id !== next.id || !previous.historyWindow || !next.historyWindow)
    return next;
  const freshIds = new Set(next.messages.map((message) => message.id));
  const previousBefore = previous.historyWindow.nextBefore;
  const nextBefore = next.historyWindow.nextBefore;
  return {
    ...next,
    messages: [
      ...previous.messages.filter((message) => !freshIds.has(message.id)),
      ...next.messages,
    ],
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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>(() => {
    dropLegacyEventLog();
    return [];
  });
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [sessionTrace, setSessionTrace] = useState<RuntimeTraceEntry[]>([]);
  const [savedSessions, setSavedSessions] = useState<SessionSnapshot[]>([]);
  const [liveDeviceState, setLiveDeviceState] = useState<DeviceState>(createEmptyDeviceState());
  const [replyBusy, setReplyBusy] = useState(false);
  const [streamingAssistantText, setStreamingAssistantText] = useState('');
  const [liveTraceItems, setLiveTraceItems] = useState<TraceFeedItem[]>([]);
  const onRuntimeEventRef = useRef(onRuntimeEvent);
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

  const refreshSavedSessions = useCallback(async (): Promise<void> => {
    const generation = accountGenerationRef.current;
    const sessions = await client.listSessions();
    if (generation === accountGenerationRef.current) setSavedSessions(sessions);
  }, [client]);

  const refreshCurrentSession = useCallback(
    async (sessionId = activeSessionId): Promise<void> => {
      if (!sessionId) return;

      const generation = accountGenerationRef.current;
      const [currentSession, currentTrace, sessions] = await Promise.all([
        client.getSessionDisplaySnapshot(sessionId),
        client.getSessionTrace(sessionId),
        client.listSessions(),
      ]);
      if (generation !== accountGenerationRef.current) return;
      setSession((previous) =>
        mergeDisplaySnapshot(previous, markServerDisplaySnapshot(currentSession)),
      );
      setSessionTrace(currentTrace);
      setSavedSessions(sessions);
      setLiveDeviceState(currentSession.deviceState);
    },
    [activeSessionId, client],
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
  }, [client, enabled, reportError]);

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
      setSessionTrace([]);
      setSavedSessions([]);
      setEvents([]);
      setLiveTraceItems([]);
      setStreamingAssistantText('');
      setReplyBusy(false);
      void client
        .listSessions()
        .then((sessions) => {
          if (generation !== accountGenerationRef.current) return;
          setSavedSessions(sessions);
          const firstId = sessions[0]?.id ?? null;
          setActiveSessionId(firstId ?? `session-${Date.now().toString(36)}`);
          if (!firstId) {
            setSession(null);
            setSessionTrace([]);
          }
        })
        .catch((error) => {
          if (generation === accountGenerationRef.current) reportError(error);
        });
    });
  }, [client, enabled, activeSessionId, reportError]);

  useEffect(() => {
    if (!enabled || !activeSessionId) return;

    let active = true;
    const sessionId = activeSessionId;
    const generation = accountGenerationRef.current;
    setReplyBusy(false);

    async function syncCurrentSession(): Promise<void> {
      const requestId = ++syncRequestIdRef.current;
      const [currentSession, currentTrace, sessions] = await Promise.all([
        client.getSessionDisplaySnapshot(sessionId),
        client.getSessionTrace(sessionId),
        client.listSessions(),
      ]);

      if (
        !active ||
        generation !== accountGenerationRef.current ||
        requestId !== syncRequestIdRef.current
      )
        return;

      setSession((previous) =>
        mergeDisplaySnapshot(previous, markServerDisplaySnapshot(currentSession)),
      );
      setSessionTrace(currentTrace);
      setSavedSessions(sessions);
      setLiveDeviceState(currentSession.deviceState);
    }

    void syncCurrentSession().catch((error) => {
      if (active && generation === accountGenerationRef.current) reportError(error);
    });

    const unsubscribe = client.subscribe((event) => {
      if (generation !== accountGenerationRef.current) return;
      setEvents((current) => [event, ...current].slice(0, RECENT_EVENT_BUFFER));

      const isActiveSessionEvent = isActiveRuntimeSessionEvent(event, sessionId);

      if (isActiveSessionEvent && event.type === 'user-message-accepted') {
        setReplyBusy(true);
        setLiveTraceItems([]);
        // The runtime has already persisted this exact message before emitting.
        // Render it from the event immediately instead of waiting for an IndexedDB
        // round trip; the subsequent snapshot refresh remains authoritative.
        setSession((current) => appendAcceptedUserMessage(current, sessionId, event.message));
      }

      if (isActiveSessionEvent) {
        const liveItem = buildLiveTraceFeedItemFromEvent(event);
        if (liveItem) {
          setLiveTraceItems((current) => [...current, liveItem]);
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

      if (event.type === 'device-state-changed') {
        setLiveDeviceState(event.state);
      }

      if (event.type === 'device-command-executed') {
        setLiveDeviceState(event.result.state);
      }

      if (
        isActiveSessionEvent &&
        (event.type === 'assistant-message-completed' || event.type === 'assistant-message-aborted')
      ) {
        setReplyBusy(false);
      }

      if (isActiveSessionEvent && shouldClearStreamingForEvent(event)) {
        setStreamingAssistantText('');
      }

      if (
        event.type === 'assistant-message-completed' ||
        event.type === 'assistant-message-aborted'
      ) {
        setStreamingAssistantText('');
      }

      if (isActiveSessionEvent) {
        onRuntimeEventRef.current?.(event);
      }

      if (shouldRefreshSessionForEvent(event)) {
        if (isActiveSessionEvent) {
          const isTurnEnd =
            event.type === 'assistant-message-completed' ||
            event.type === 'assistant-message-aborted';
          void syncCurrentSession()
            .then(() => {
              if (isTurnEnd) setLiveTraceItems([]);
            })
            .catch((error) => {
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
  }, [activeSessionId, client, enabled, refreshSavedSessions, reportError]);

  return {
    activeSessionId,
    setActiveSessionId,
    events,
    clearEvents,
    session,
    sessionTrace,
    setSession,
    savedSessions,
    setSavedSessions,
    liveDeviceState,
    replyBusy,
    streamingAssistantText,
    clearStreamingAssistantText,
    setStreamingAssistantText,
    liveTraceItems,
    refreshCurrentSession,
    loadOlderSessionMessages,
  };
}
