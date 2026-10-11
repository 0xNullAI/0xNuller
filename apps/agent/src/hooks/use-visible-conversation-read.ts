import { useEffect, useRef, useState } from 'react';
import {
  currentAuthUserId,
  markPrivateConversationRead,
  subscribeAuthChanges,
} from '@0xnullai/auth';
import type { SessionSnapshot } from '@dg-agent/core';
import { getObservedConversationSequence } from '@dg-agent/storage-browser';

interface Options {
  session: SessionSnapshot | null;
  activeSessionId: string | null;
  visible: boolean;
}

/** Acknowledge only messages present in the conversation actually rendered on screen. */
export function useVisibleConversationRead({ session, activeSessionId, visible }: Options): void {
  const [revision, setRevision] = useState(0);
  const authEpoch = useRef(0);
  const observedAccount = useRef(currentAuthUserId());
  const pending = useRef(new Set<string>());
  const completed = useRef(new Map<string, number>());

  useEffect(() => {
    const changed = () => {
      const nextAccount = currentAuthUserId();
      if (nextAccount === observedAccount.current) return;
      observedAccount.current = nextAccount;
      authEpoch.current++;
      completed.current.clear();
      setRevision((value) => value + 1);
    };
    const becameVisible = () => setRevision((value) => value + 1);
    const unsubscribe = subscribeAuthChanges(changed);
    document.addEventListener('visibilitychange', becameVisible);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', becameVisible);
    };
  }, []);

  useEffect(() => {
    if (
      !visible ||
      document.visibilityState !== 'visible' ||
      !session ||
      session.id !== activeSessionId ||
      !session.messages.some((message) => message.role === 'user' || message.role === 'assistant')
    )
      return;
    const account = currentAuthUserId();
    const sequence = getObservedConversationSequence(session, account);
    if (!account || sequence === null || sequence === 0) return;
    const conversationKey = JSON.stringify([account, session.id]);
    const key = JSON.stringify([account, session.id, sequence]);
    if (pending.current.has(key) || (completed.current.get(conversationKey) ?? -1) >= sequence)
      return;
    const epoch = authEpoch.current;
    const timer = window.setTimeout(() => {
      if (
        epoch !== authEpoch.current ||
        currentAuthUserId() !== account ||
        document.visibilityState !== 'visible' ||
        pending.current.has(key) ||
        (completed.current.get(conversationKey) ?? -1) >= sequence
      )
        return;
      pending.current.add(key);
      void markPrivateConversationRead(session.id, sequence)
        .then(() => {
          if (epoch !== authEpoch.current || currentAuthUserId() !== account) return;
          completed.current.set(
            conversationKey,
            Math.max(completed.current.get(conversationKey) ?? -1, sequence),
          );
          window.dispatchEvent(new Event('0xnullai:conversation-updated'));
        })
        .catch(() => {
          // An offline or stale-account acknowledgement leaves unread state intact.
        })
        .finally(() => {
          pending.current.delete(key);
          if (epoch !== authEpoch.current && currentAuthUserId() === account)
            setRevision((value) => value + 1);
        });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, revision, session, visible]);
}
