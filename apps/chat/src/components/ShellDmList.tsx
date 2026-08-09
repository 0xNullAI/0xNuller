import { useCallback, useEffect, useState } from 'react';
import type { DmConversation } from '@0xnullai/auth';
import { loadDmList, type DmListEntry } from '../lib/dm';

/**
 * The private-message list in the shell sidebar.
 *
 * It sits in its own section rather than in 「房间」 because the two are not the same kind
 * of thing: a room is somewhere you go, a conversation is someone who is waiting. Mixing
 * them would also put a person's name in a list of public rooms, which is the one place a
 * private conversation must never appear.
 *
 * **This component is only ever rendered for a signed-in user** — see App.tsx. A DM cannot
 * be anonymous (only an account can answer "who may message me"), so signed out there is
 * no section, no heading and no empty state hinting at a feature that is not available.
 *
 * The list is re-fetched rather than pushed. Chat holds one WebSocket at a time, so there
 * is no socket open for a conversation you are not looking at and nothing to receive an
 * unread count on; polling the two services is what makes the badge exist at all. It is
 * also re-authorized every time — the account service returns only conversations that are
 * still mutual follows, so a conversation whose follow went away leaves the sidebar on the
 * next poll without anything having to remember to remove it.
 */

/** How often the list is refreshed. Slow on purpose: it is a badge, not a message stream. */
const POLL_MS = 30_000;

export interface ShellDmListProps {
  /** The conversation currently open, if any, so it can be highlighted and shown as read. */
  currentRoom: string | null;
  onOpen: (peer: DmConversation) => void;
}

export function ShellDmList({ currentRoom, onOpen }: ShellDmListProps) {
  // null means "not loaded yet", which is a different state from "no conversations".
  const [entries, setEntries] = useState<DmListEntry[] | null>(null);

  const refresh = useCallback(() => {
    // loadDmList never throws: signed out and an unreachable service both arrive as null.
    void loadDmList().then((list) => setEntries(list ?? []));
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
    // currentRoom is in the deps so opening or leaving a conversation refreshes the list
    // straight away instead of up to POLL_MS later.
  }, [refresh, currentRoom]);

  if (entries === null) {
    return <p className="px-2 py-2 text-xs text-[var(--text-faint)]">加载中…</p>;
  }

  if (entries.length === 0) {
    return (
      <p className="px-2 py-2 text-xs text-[var(--text-faint)]">
        还没有私聊。在联系人里找到互相关注的人就能开始。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {entries.map((entry) => {
        const active = entry.peer.room === currentRoom;
        // The conversation you are looking at is read by definition. Waiting for the local
        // mark to make it back through the next poll would leave a badge on the thing that
        // is open on screen.
        const unread = active ? 0 : entry.unread;
        return (
          <button
            key={entry.peer.id}
            type="button"
            onClick={() => onOpen(entry.peer)}
            className={
              'flex items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-sm transition-colors ' +
              (active
                ? 'bg-[var(--accent-soft)]'
                : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]')
            }
          >
            <span className="min-w-0 flex-1 truncate">
              {entry.peer.displayName || entry.peer.username}
            </span>
            {unread > 0 && (
              <span className="shrink-0 rounded-full bg-[var(--accent)] px-1.5 text-[10px] tabular-nums text-[var(--button-text)]">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
