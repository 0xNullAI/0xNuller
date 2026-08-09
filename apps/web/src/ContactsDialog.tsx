import { useEffect, useState } from 'react';
import { MessageSquare, Search } from 'lucide-react';
import { Avatar, Button, Input, Overlay } from '@0xnullai/ui';
import {
  followUser,
  getUser,
  listFollowers,
  listFollowing,
  openDirectMessage,
  requestProfileView,
  unfollowUser,
  type AuthUser,
  type Contact,
  type ContactActionResult,
  type PublicUserView,
} from '@0xnullai/auth';

/**
 * Contacts.
 *
 * Following is directional, so the dialog is two lists: who you follow and who
 * follows you. A **contact** is not a third thing to manage — it is both
 * directions existing, which is why mutual rows are only labelled rather than
 * filed somewhere separate.
 *
 * Finding someone is by username, typed in. There is deliberately no browsable
 * directory of accounts: in this product being discoverable has to be something
 * a person chose, and a list of everyone is the opposite of that. The lookup
 * answers the same way for "no such user" and "one of you blocked the other",
 * so a block cannot be detected by probing.
 *
 * None of the rules live here. Self-follow, following someone who blocked you
 * and blocking clearing the follows are all enforced by the account service;
 * this only shows what came back.
 */

type Tab = 'following' | 'followers';

const TABS: { id: Tab; label: string }[] = [
  { id: 'following', label: '关注' },
  { id: 'followers', label: '粉丝' },
];

function Row({
  username,
  displayName,
  mutual,
  following,
  busy,
  onToggle,
  onMessage,
}: {
  username: string;
  displayName: string;
  mutual: boolean;
  following: boolean;
  busy: boolean;
  onToggle: () => void;
  /** Only supplied for a mutual row — a one-way follow cannot start a conversation. */
  onMessage?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-sm)] px-2 py-2 hover:bg-[var(--bg-soft)]">
      <Avatar
        name={displayName}
        username={username}
        size={34}
        onOpenProfile={requestProfileView}
      />
      <button
        type="button"
        onClick={() => requestProfileView(username)}
        className="min-w-0 flex-1 text-left"
      >
        <div className="truncate text-sm font-medium">{displayName}</div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs text-[var(--text-faint)]">@{username}</span>
          {mutual && <span className="shrink-0 text-[10px] text-[var(--accent)]">互相关注</span>}
        </div>
      </button>
      {/* Shown on mutual rows only, and not because the server would trust the absence of a
          button — it refuses to admit anyone else regardless. It is shown here because a
          button that always answers 「需要互相关注」 teaches nothing about what the rule is.
          A sibling of the row rather than inside it: the row itself is now a button that
          opens the profile, and a button inside a button is invalid markup that browsers
          resolve by dropping one of them. */}
      {onMessage && (
        <Button size="sm" variant="secondary" aria-label="私聊" onClick={onMessage}>
          <MessageSquare className="h-4 w-4" />
        </Button>
      )}
      <Button
        size="sm"
        variant={following ? 'secondary' : 'default'}
        disabled={busy}
        onClick={onToggle}
      >
        {following ? '取消关注' : '关注'}
      </Button>
    </div>
  );
}

export function ContactsDialog({ user, onClose }: { user: AuthUser; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('following');
  // null means "not loaded yet", which is a different state from an empty list —
  // showing 「还没有关注任何人」 while the request is still out is wrong.
  const [lists, setLists] = useState<Record<Tab, Contact[] | null>>({
    following: null,
    followers: null,
  });
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<PublicUserView | null>(null);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a follow or unfollow to re-run the fetch below. An action cannot
  // load the list itself: the dialog can be closed while the request is in flight,
  // and only the effect knows when that happened.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    // The client never throws: signed out and an unreachable service both arrive
    // as an empty page rather than as an exception inside the shell.
    void (tab === 'following' ? listFollowing() : listFollowers()).then((page) => {
      if (alive) setLists((prev) => ({ ...prev, [tab]: page.users }));
    });
    return () => {
      alive = false;
    };
  }, [tab, reloadKey]);

  async function act(userId: string, run: () => Promise<ContactActionResult>) {
    setBusyId(userId);
    setError(null);
    const result = await run();
    if (!result.ok) setError(result.error ?? '操作失败');

    // Both lists move together: 关注 gains or loses a row, and the rows in 粉丝
    // change whether they are mutual. Dropping both back to unloaded and
    // refetching the visible one keeps the two from disagreeing.
    setLists({ following: null, followers: null });
    setReloadKey((k) => k + 1);
    if (found) setFound(await getUser(found.user.username));
    setBusyId(null);
  }

  const toggle = (id: string, following: boolean) =>
    act(id, () => (following ? unfollowUser(id) : followUser(id)));

  /**
   * Start (or return to) a conversation.
   *
   * One call does everything: openDirectMessage navigates to the module that owns
   * conversations and leaves the request for it, so this dialog needs to know nothing about
   * Chat. Closing afterwards is the point — the conversation is what the user asked for, and
   * leaving a dialog over it would just have to be dismissed.
   */
  function startDm(peer: { id: string; username: string; displayName: string }) {
    openDirectMessage(peer.id, { username: peer.username, displayName: peer.displayName });
    onClose();
  }

  async function search() {
    const name = query.trim();
    if (!name) return;
    setSearching(true);
    setError(null);
    setFound(await getUser(name));
    setSearched(true);
    setSearching(false);
  }

  const rows = lists[tab];

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="联系人"
        className="flex max-h-[min(600px,calc(100dvh-2rem))] w-[min(420px,calc(100vw-2rem))] flex-col rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-panel)] sm:p-6"
      >
        <h2 className="text-lg font-semibold">联系人</h2>
        <p className="mt-1 text-sm text-[var(--text-soft)]">
          关注是单向的，互相关注才会显示为联系人，也才能私聊。
        </p>

        <div className="mt-4 flex gap-2">
          <Input
            value={query}
            placeholder="输入用户名查找"
            aria-label="用户名"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search();
            }}
          />
          <Button
            variant="secondary"
            aria-label="查找"
            disabled={searching || !query.trim()}
            onClick={() => void search()}
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>

        {searched &&
          (found ? (
            <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-1">
              {found.user.id === user.id ? (
                <div className="flex items-center gap-3 px-2 py-2">
                  <Avatar
                    name={found.user.displayName}
                    username={found.user.username}
                    size={34}
                    onOpenProfile={requestProfileView}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{found.user.displayName}</div>
                    <div className="truncate text-xs text-[var(--text-faint)]">这是你自己</div>
                  </div>
                </div>
              ) : (
                <Row
                  username={found.user.username}
                  displayName={found.user.displayName}
                  mutual={found.following && found.followedBy}
                  following={found.following}
                  busy={busyId === found.user.id}
                  onToggle={() => void toggle(found.user.id, found.following)}
                  onMessage={
                    found.following && found.followedBy
                      ? () => startDm(found.user)
                      : undefined
                  }
                />
              )}
            </div>
          ) : (
            // Same message whether the account does not exist or one of you
            // blocked the other. Telling them apart would make the block itself
            // detectable, and here that invites exactly the attention blocking
            // was meant to end.
            <p className="mt-2 text-xs text-[var(--text-faint)]">没有找到这个用户。</p>
          ))}

        <div className="mt-4 flex gap-1 border-b border-[var(--surface-border)]">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={t.id === tab || undefined}
              className={
                'px-3 pb-2 text-sm transition-colors ' +
                (t.id === tab
                  ? 'border-b-2 border-[var(--accent)] font-medium text-[var(--text)]'
                  : 'text-[var(--text-soft)] hover:text-[var(--text)]')
              }
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto py-1">
          {rows === null ? (
            <p
              role="status"
              aria-live="polite"
              className="px-2 py-6 text-center text-xs text-[var(--text-faint)]"
            >
              加载中…
            </p>
          ) : rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-[var(--text-faint)]">
              {tab === 'following'
                ? '还没有关注任何人。查找用户名可以关注对方。'
                : '还没有人关注你。'}
            </p>
          ) : (
            rows.map((row) => (
              <Row
                key={row.id}
                username={row.username}
                displayName={row.displayName}
                mutual={row.mutual}
                // In 关注 you follow every row by definition; in 粉丝 only the
                // mutual ones, and the rest get a 关注 button to follow back.
                following={tab === 'following' || row.mutual}
                busy={busyId === row.id}
                onToggle={() => void toggle(row.id, tab === 'following' || row.mutual)}
                onMessage={row.mutual ? () => startDm(row) : undefined}
              />
            ))
          )}
        </div>

        {error && (
          <p className="mt-2 rounded-[var(--radius-ctl)] border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
