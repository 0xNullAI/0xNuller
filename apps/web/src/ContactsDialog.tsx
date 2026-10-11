import { useEffect, useRef, useState } from 'react';
import { MessageSquare, RefreshCw, Search } from 'lucide-react';
import { Avatar, Button, Input, Overlay } from '@0xnullai/ui';
import {
  followUser,
  getUser,
  listContacts,
  listBlocks,
  listDiscoverableUsers,
  listFollowers,
  listFollowing,
  openDirectMessage,
  removeFollower,
  requestProfileView,
  unfollowUser,
  unblockUser,
  type AuthUser,
  type Contact,
  type ContactPage,
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
 * Discovery pages only include accounts returned by the service. Username
 * lookup answers the same way for "no such user" and "one of you blocked the
 * other", so a block cannot be detected by probing.
 *
 * None of the rules live here. Self-follow, following someone who blocked you
 * and blocking clearing the follows are all enforced by the account service;
 * this only shows what came back.
 */

type Tab = 'discover' | 'contacts' | 'following' | 'followers' | 'blocked';

const TABS: { id: Tab; label: string }[] = [
  { id: 'contacts', label: '好友' },
  { id: 'discover', label: '发现' },
  { id: 'following', label: '关注' },
  { id: 'followers', label: '粉丝' },
  { id: 'blocked', label: '黑名单' },
];

function Row({
  username,
  displayName,
  mutual,
  following,
  busy,
  onToggle,
  onMessage,
  onRemove,
  details,
  blocked = false,
}: {
  username: string;
  displayName: string;
  mutual: boolean;
  following: boolean;
  busy: boolean;
  onToggle: () => void;
  /** Only supplied for a mutual row — a one-way follow cannot start a conversation. */
  onMessage?: () => void;
  onRemove?: () => void;
  details?: { bio?: string | null };
  blocked?: boolean;
}) {
  return (
    <div className="rounded-xl border-b border-[var(--surface-border)] px-2 py-3 hover:bg-[var(--bg-soft)] sm:flex sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar
          name={displayName}
          username={username}
          size={42}
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
            {mutual && <span className="shrink-0 text-xs text-[var(--accent)]">互相关注</span>}
          </div>
          {details?.bio ? (
            <p className="mt-1 line-clamp-1 text-xs text-[var(--text-soft)]">{details.bio}</p>
          ) : null}
        </button>
      </div>
      {/* Shown on mutual rows only, and not because the server would trust the absence of a
          button — it refuses to admit anyone else regardless. It is shown here because a
          button that always answers 「需要互相关注」 teaches nothing about what the rule is.
          A sibling of the row rather than inside it: the row itself is now a button that
          opens the profile, and a button inside a button is invalid markup that browsers
          resolve by dropping one of them. */}
      <div className="mt-2 flex shrink-0 flex-wrap items-center justify-end gap-1.5 pl-[54px] sm:mt-0 sm:pl-0">
        {onMessage && (
          <Button size="sm" variant="secondary" onClick={onMessage}>
            <MessageSquare className="h-4 w-4" /> 私聊
          </Button>
        )}
        {onRemove && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
            移除
          </Button>
        )}
        <Button
          size="sm"
          variant={following || blocked ? 'secondary' : 'default'}
          disabled={busy}
          onClick={onToggle}
        >
          {blocked ? '解除屏蔽' : following ? '取消关注' : '关注'}
        </Button>
      </div>
    </div>
  );
}

export function ContactsDialog({
  user,
  onClose,
  presentation = 'dialog',
}: {
  user: AuthUser;
  onClose: () => void;
  presentation?: 'dialog' | 'page';
}) {
  return (
    <AccountContacts key={user.id} user={user} onClose={onClose} presentation={presentation} />
  );
}

function AccountContacts({
  user,
  onClose,
  presentation = 'dialog',
}: {
  user: AuthUser;
  onClose: () => void;
  presentation?: 'dialog' | 'page';
}) {
  const [tab, setTab] = useState<Tab>('contacts');
  // null means "not loaded yet", which is a different state from an empty list —
  // showing 「还没有关注任何人」 while the request is still out is wrong.
  const [lists, setLists] = useState<Record<Tab, Contact[] | null>>({
    contacts: null,
    following: null,
    followers: null,
    discover: null,
    blocked: null,
  });
  const [nextOffsets, setNextOffsets] = useState<Record<Tab, number | null>>({
    contacts: null,
    following: null,
    followers: null,
    discover: null,
    blocked: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [discoverOffset, setDiscoverOffset] = useState(0);
  const pageEpoch = useRef(0);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<PublicUserView | null>(null);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const lookupEpoch = useRef(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a follow or unfollow to re-run the fetch below. An action cannot
  // load the list itself: the dialog can be closed while the request is in flight,
  // and only the effect knows when that happened.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    pageEpoch.current += 1;
    // The client never throws: signed out and an unreachable service both arrive
    // as an empty page rather than as an exception inside the shell.
    const request =
      tab === 'blocked'
        ? listBlocks().then((users) => ({
            users: users.map((item) => ({
              ...item,
              followedAt: item.blockedAt,
              mutual: false,
              following: false,
            })),
            nextOffset: null,
          }))
        : tab === 'discover'
          ? listDiscoverableUsers({ limit: 20, offset: discoverOffset }).then((page) => ({
              users: page.users.map((item) => ({
                id: item.id,
                username: item.username,
                displayName: item.displayName,
                followedAt: 0,
                mutual: item.following && item.followedBy,
                following: item.following,
                avatarUrl: item.avatarUrl,
                bio: item.bio,
                location: item.location,
                interests: item.interests,
              })),
              nextOffset: page.nextOffset,
            }))
          : tab === 'contacts'
            ? listContacts()
            : tab === 'following'
              ? listFollowing()
              : listFollowers();
    void request.then((page) => {
      if (alive) {
        setLists((prev) => ({ ...prev, [tab]: page.users }));
        setNextOffsets((prev) => ({ ...prev, [tab]: page.nextOffset }));
      }
    });
    return () => {
      alive = false;
    };
  }, [tab, reloadKey, user.id, discoverOffset]);

  async function loadMore() {
    const offset = nextOffsets[tab];
    if (offset === null || loadingMore) return;
    const epoch = pageEpoch.current;
    setLoadingMore(true);
    try {
      const page: ContactPage =
        tab === 'discover'
          ? await listDiscoverableUsers({ limit: 20, offset }).then((result) => ({
              users: result.users.map((item) => ({
                id: item.id,
                username: item.username,
                displayName: item.displayName,
                followedAt: 0,
                mutual: item.following && item.followedBy,
                following: item.following,
                avatarUrl: item.avatarUrl,
                bio: item.bio,
                location: item.location,
                interests: item.interests,
              })),
              nextOffset: result.nextOffset,
            }))
          : tab === 'contacts'
            ? await listContacts({ limit: 20, offset })
            : tab === 'following'
              ? await listFollowing({ limit: 20, offset })
              : await listFollowers({ limit: 20, offset });
      if (epoch !== pageEpoch.current) return;
      setLists((prev) => ({
        ...prev,
        [tab]: [
          ...(prev[tab] ?? []),
          ...page.users.filter((item) => !prev[tab]?.some((old) => old.id === item.id)),
        ],
      }));
      setNextOffsets((prev) => ({ ...prev, [tab]: page.nextOffset }));
    } catch {
      if (epoch === pageEpoch.current) setError('加载联系人失败，请重试。');
    } finally {
      if (epoch === pageEpoch.current) setLoadingMore(false);
    }
  }

  async function act(userId: string, run: () => Promise<ContactActionResult>) {
    setBusyId(userId);
    setError(null);
    const result = await run();
    if (!result.ok) setError(result.error ?? '操作失败');

    // Both lists move together: 关注 gains or loses a row, and the rows in 粉丝
    // change whether they are mutual. Dropping both back to unloaded and
    // refetching the visible one keeps the two from disagreeing.
    setLists({ discover: null, contacts: null, following: null, followers: null, blocked: null });
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
    // On the standalone /people page, openDirectMessage already navigates to
    // /chat. Its onClose goes to /, which would immediately undo that route.
    if (presentation === 'dialog') onClose();
  }

  async function search() {
    const name = query.trim();
    if (!name) return;
    const epoch = ++lookupEpoch.current;
    setSearching(true);
    setError(null);
    const match = await getUser(name);
    if (epoch !== lookupEpoch.current) return;
    setFound(match);
    setSearched(true);
    setSearching(false);
  }

  const rows = lists[tab];
  const needle = query.trim().toLocaleLowerCase();
  const filteredRows =
    rows?.filter((row) =>
      `${row.username} ${row.displayName}`.toLocaleLowerCase().includes(needle),
    ) ?? rows;

  const content = (
    <div
      role={presentation === 'dialog' ? 'dialog' : 'region'}
      aria-modal={presentation === 'dialog' || undefined}
      aria-label="交友"
      className={
        presentation === 'dialog'
          ? 'flex max-h-[min(680px,calc(100dvh-2rem))] w-[min(480px,calc(100vw-2rem))] flex-col rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4 shadow-[var(--shadow-panel)] sm:p-6'
          : 'mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-3 py-2 sm:px-8 sm:py-8'
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className={presentation === 'page' ? 'hidden sm:block' : ''}>
          <h2 className="text-xl font-semibold">联系人</h2>
        </div>
        {tab === 'discover' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setLoadingMore(false);
              setDiscoverOffset(nextOffsets.discover ?? 0);
              setLists((prev) => ({ ...prev, discover: null }));
              setReloadKey((key) => key + 1);
            }}
          >
            <RefreshCw className="h-4 w-4" /> 换一批
          </Button>
        )}
      </div>

      <div className="mt-3 flex gap-2 sm:mt-5">
        <Input
          value={query}
          placeholder="搜索联系人或用户名"
          aria-label="搜索用户名或联系人"
          onChange={(e) => {
            lookupEpoch.current += 1;
            setQuery(e.target.value);
            setFound(null);
            setSearched(false);
            setSearching(false);
          }}
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
                  found.following && found.followedBy ? () => startDm(found.user) : undefined
                }
              />
            )}
          </div>
        ) : (
          // Same message whether the account does not exist or one of you
          // blocked the other. Telling them apart would make the block itself
          // detectable, and here that invites exactly the attention blocking
          // was meant to end.
          <p className="mt-2 text-sm text-[var(--text-faint)]">未找到用户</p>
        ))}

      <div
        className="mt-4 flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--surface-border)]"
        role="tablist"
        aria-label="联系人分类"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setLoadingMore(false);
              if (t.id === 'discover' && tab !== 'discover') setDiscoverOffset(0);
              setTab(t.id);
            }}
            role="tab"
            aria-selected={t.id === tab}
            className={
              'min-h-11 shrink-0 whitespace-nowrap px-3 text-sm transition-colors ' +
              (t.id === tab
                ? 'border-b-2 border-[var(--accent)] font-medium text-[var(--text)]'
                : 'text-[var(--text-soft)] hover:text-[var(--text)]')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="-mx-2 min-h-0 flex-1 overflow-y-auto py-1" role="tabpanel">
        {rows === null ? (
          <p
            role="status"
            aria-live="polite"
            className="px-2 py-6 text-center text-sm text-[var(--text-faint)]"
          >
            加载中…
          </p>
        ) : rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-[var(--text-faint)]">
            {tab === 'contacts'
              ? '暂无好友，互相关注后会显示在这里'
              : tab === 'discover'
                ? '暂无可发现的用户'
                : tab === 'blocked'
                  ? '黑名单为空'
                  : tab === 'following'
                    ? '暂无关注，搜索用户名即可添加'
                    : '暂无粉丝'}
          </p>
        ) : filteredRows?.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-[var(--text-faint)]">没有匹配的联系人</p>
        ) : (
          filteredRows?.map((row) => (
            <Row
              key={row.id}
              username={row.username}
              displayName={row.displayName}
              mutual={row.mutual}
              details={tab === 'discover' ? row : undefined}
              blocked={tab === 'blocked'}
              // In 关注 you follow every row by definition; in 粉丝 only the
              // mutual ones, and the rest get a 关注 button to follow back.
              following={
                tab === 'discover'
                  ? Boolean(row.following)
                  : tab === 'blocked'
                    ? false
                    : tab !== 'followers' || row.mutual
              }
              busy={busyId === row.id}
              onToggle={() =>
                void (tab === 'blocked'
                  ? act(row.id, () => unblockUser(row.id))
                  : toggle(
                      row.id,
                      tab === 'discover'
                        ? Boolean(row.following)
                        : tab !== 'followers' || row.mutual,
                    ))
              }
              onMessage={row.mutual ? () => startDm(row) : undefined}
              onRemove={
                tab === 'followers'
                  ? () => void act(row.id, () => removeFollower(row.id))
                  : undefined
              }
            />
          ))
        )}
        {rows !== null && nextOffsets[tab] !== null && (
          <div className="px-2 py-3 text-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? '加载中…' : '加载更多'}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 rounded-[var(--radius-ctl)] border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {presentation === 'dialog' ? (
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </div>
      ) : null}
    </div>
  );
  return presentation === 'page' ? content : <Overlay onDismiss={onClose}>{content}</Overlay>;
}
