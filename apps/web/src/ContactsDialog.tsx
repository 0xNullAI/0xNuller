import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  RefreshCw,
  Search,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { Avatar, Button, ModuleActions, Overlay, subscribeMediaQuery } from '@0xnullai/ui';
import {
  avatarSrc,
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
type ListTab = 'contacts' | 'following' | 'followers';
/** Screens pushed over the list. Their URL form is `/people?view=<id>`. */
type SubView = 'discover' | 'blocked';

const TABS: { id: ListTab; label: string }[] = [
  { id: 'contacts', label: '好友' },
  { id: 'following', label: '关注' },
  { id: 'followers', label: '粉丝' },
];

const SUB_VIEW_TITLE: Record<SubView, string> = { discover: '添加朋友', blocked: '黑名单' };

function subViewFromSearch(search: string): SubView | null {
  const view = new URLSearchParams(search).get('view');
  return view === 'discover' || view === 'blocked' ? view : null;
}

const iconButton =
  'ui-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--accent-text)] hover:bg-[var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-45';

/**
 * One contact: the whole row opens the profile, and at most one trailing action that fits on
 * the same line. Unfollow, block and report live on the profile page.
 */
function Row({
  username,
  displayName,
  avatarUrl,
  status,
  mutual,
  action,
}: {
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  /** One line under the name. Defaults to the handle. */
  status?: string | null;
  mutual: boolean;
  action?: ReactNode;
}) {
  return (
    // The action is a sibling of the row button: a button inside a button is invalid markup
    // that browsers resolve by dropping one of them.
    <div className="flex min-w-0 items-center">
      <button
        type="button"
        onClick={() => requestProfileView(username)}
        className="ui-press-row flex min-h-[64px] min-w-0 flex-1 items-center gap-3 pl-4 text-left hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
      >
        <Avatar name={displayName} username={username} src={avatarSrc(avatarUrl)} size={48} />
        <span className="flex min-h-[64px] min-w-0 flex-1 flex-col justify-center border-b-[0.5px] border-[var(--surface-border)] py-2 pr-2">
          <span className="block truncate text-base font-medium leading-6">{displayName}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-sm leading-5 text-[var(--text-faint)]">
            <span className="truncate">{status || `@${username}`}</span>
            {mutual && <span className="shrink-0 text-[var(--accent-text)]">互相关注</span>}
          </span>
        </span>
      </button>
      {action ? (
        <span className="flex min-h-[64px] shrink-0 items-center gap-1 self-stretch border-b-[0.5px] border-[var(--surface-border)] pr-3">
          {action}
        </span>
      ) : null}
    </div>
  );
}

function ListMessage({ children, status = false }: { children: ReactNode; status?: boolean }) {
  return (
    <p
      role={status ? 'status' : undefined}
      aria-live={status ? 'polite' : undefined}
      className="px-4 py-10 text-center text-sm text-[var(--text-faint)]"
    >
      {children}
    </p>
  );
}

function RowsSkeleton() {
  return (
    <div role="status" aria-label="加载中">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} aria-hidden className="flex min-h-[64px] items-center gap-3 px-4">
          <span className="ui-skeleton h-12 w-12 shrink-0 rounded-full" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="ui-skeleton h-3.5 w-1/3" />
            <span className="ui-skeleton h-3 w-1/2" />
          </span>
        </div>
      ))}
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
  const page = presentation === 'page';
  const [listTab, setListTab] = useState<ListTab>('contacts');
  // The page keeps its pushed screen in the URL so a deep link or a reload opens it, and the
  // system back gesture closes it. The dialog form has no URL of its own.
  // On the page the URL is the only source, read on every render, so the shell's own
  // navigation (the 联系人 tab pressed inside a pushed screen) can never disagree with it.
  const [dialogSubView, setDialogSubView] = useState<SubView | null>(null);
  const [, setUrlRevision] = useState(0);
  const subView = page ? subViewFromSearch(window.location.search) : dialogSubView;
  const pushedSubView = useRef(false);
  const tab: Tab = subView ?? listTab;
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

  const resetSearch = () => {
    lookupEpoch.current += 1;
    setQuery('');
    setFound(null);
    setSearched(false);
    setSearching(false);
  };

  useEffect(() => {
    if (!page) return;
    const sync = () => {
      if (!subViewFromSearch(window.location.search)) pushedSubView.current = false;
      setUrlRevision((value) => value + 1);
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [page]);

  function openSubView(next: SubView) {
    setLoadingMore(false);
    setError(null);
    resetSearch();
    if (next === 'discover') setDiscoverOffset(0);
    if (!page) {
      setDialogSubView(next);
      return;
    }
    window.history.pushState(null, '', `/people?view=${next}`);
    pushedSubView.current = true;
    // Tells the shell and this page to re-read the URL; the navigation guard ignores a
    // state-less popstate on an unchanged document.
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  function closeSubView() {
    setLoadingMore(false);
    setError(null);
    resetSearch();
    if (!page) {
      setDialogSubView(null);
      return;
    }
    if (pushedSubView.current) {
      // The popstate it fires brings the page back to the list.
      window.history.back();
      return;
    }
    // Opened from a deep link: there is no list entry behind it to go back to.
    window.history.replaceState(null, '', '/people');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

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

  /** The one trailing action a row gets, chosen by what the relationship allows. */
  function rowAction(row: Contact): ReactNode {
    const busy = busyId === row.id;
    if (tab === 'blocked')
      return (
        <Button
          size="sm"
          variant="secondary"
          className="ui-press whitespace-nowrap rounded-full"
          disabled={busy}
          onClick={() => void act(row.id, () => unblockUser(row.id))}
        >
          解除屏蔽
        </Button>
      );
    // Only a mutual row can message: the server admits nobody else, and a button that always
    // answers 「需要互相关注」 teaches nothing about the rule.
    const primary = row.mutual ? (
      <button type="button" aria-label="私聊" className={iconButton} onClick={() => startDm(row)}>
        <MessageCircle className="h-5 w-5" aria-hidden />
      </button>
    ) : tab === 'followers' || (tab === 'discover' && !row.following) ? (
      <button
        type="button"
        aria-label={tab === 'followers' ? '回关' : '关注'}
        className={iconButton}
        disabled={busy}
        onClick={() => void toggle(row.id, false)}
      >
        <UserPlus className="h-5 w-5" aria-hidden />
      </button>
    ) : null;
    if (tab !== 'followers') return primary;
    return (
      <>
        {primary}
        <button
          type="button"
          aria-label="移除粉丝"
          title="移除粉丝"
          className={`${iconButton} text-[var(--text-faint)] hover:bg-[var(--bg-soft)]`}
          disabled={busy}
          onClick={() => void act(row.id, () => removeFollower(row.id))}
        >
          <UserMinus className="h-5 w-5" aria-hidden />
        </button>
      </>
    );
  }

  const searchField = (
    <label className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-[var(--bg-soft)] px-3 text-[var(--text-faint)]">
      <Search className="h-4 w-4 shrink-0" aria-hidden />
      <input
        type="search"
        value={query}
        placeholder={subView === 'discover' ? '输入用户名' : '搜索'}
        aria-label={subView === 'discover' ? '搜索用户名' : '搜索联系人'}
        onChange={(e) => {
          lookupEpoch.current += 1;
          setQuery(e.target.value);
          setFound(null);
          setSearched(false);
          setSearching(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && subView === 'discover') void search();
        }}
        className="min-h-0 min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-sm text-[var(--text)] shadow-none outline-none placeholder:text-[var(--text-faint)] focus:ring-0"
      />
    </label>
  );

  const addButton = (
    <button
      type="button"
      aria-label="添加朋友"
      title="添加朋友"
      onClick={() => openSubView('discover')}
      className="ui-press flex h-11 w-11 items-center justify-center rounded-full text-[var(--text)] hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <UserPlus className="h-[22px] w-[22px]" aria-hidden />
    </button>
  );

  const list = (
    <>
      {rows === null ? (
        <RowsSkeleton />
      ) : rows.length === 0 ? (
        <ListMessage>
          {tab === 'contacts'
            ? '暂无好友，互相关注后会显示在这里'
            : tab === 'discover'
              ? '暂无可发现的用户'
              : tab === 'blocked'
                ? '黑名单为空'
                : tab === 'following'
                  ? '暂无关注'
                  : '暂无粉丝'}
        </ListMessage>
      ) : filteredRows?.length === 0 ? (
        <ListMessage>没有匹配的联系人</ListMessage>
      ) : (
        filteredRows?.map((row) => (
          <Row
            key={row.id}
            username={row.username}
            displayName={row.displayName}
            avatarUrl={row.avatarUrl}
            status={tab === 'discover' ? row.bio : null}
            mutual={row.mutual}
            action={rowAction(row)}
          />
        ))
      )}
      {rows !== null && nextOffsets[tab] !== null && (
        <div className="px-4 py-3 text-center">
          <Button variant="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? '加载中…' : '加载更多'}
          </Button>
        </div>
      )}
    </>
  );

  const errorLine = error && (
    <p role="alert" className="mx-4 mt-2 text-sm text-[var(--danger)]">
      {error}
    </p>
  );

  const wide = useIsWide();
  const listScreen = (
    <div key="list" className="ui-tab-fade flex min-h-0 flex-1 flex-col">
      {/* On a phone the shell top bar already shows the title and the add action. */}
      <div className={`flex min-h-14 items-center gap-2 pl-4 pr-2 ${page ? 'max-md:hidden' : ''}`}>
        <h2 className={`min-w-0 flex-1 text-xl font-semibold ${page ? 'hidden md:block' : ''}`}>
          联系人
        </h2>
        {/* Phone: the add action lives in the shell top bar; wide screens keep it by the title. */}
        {page && !wide ? <ModuleActions>{addButton}</ModuleActions> : addButton}
      </div>
      <div className="px-4 pb-2">{searchField}</div>
      <div
        className="flex shrink-0 gap-6 border-b-[0.5px] border-[var(--surface-border)] px-4"
        role="tablist"
        aria-label="联系人分类"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setLoadingMore(false);
              setListTab(t.id);
            }}
            role="tab"
            aria-selected={t.id === tab}
            className={
              'relative min-h-11 shrink-0 whitespace-nowrap text-[15px] transition-colors ' +
              (t.id === tab
                ? 'font-medium text-[var(--text)] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--accent)]'
                : 'text-[var(--text-soft)] hover:text-[var(--text)]')
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
        <div key={tab} className="ui-tab-fade">
          {list}
        </div>
        {errorLine}
        <button
          type="button"
          onClick={() => openSubView('blocked')}
          className="ui-press-row mt-4 flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
        >
          <Ban className="h-5 w-5 shrink-0 text-[var(--text-faint)]" aria-hidden />
          <span className="flex-1">黑名单</span>
          <ChevronRight className="h-4 w-4 text-[var(--text-faint)]" aria-hidden />
        </button>
      </div>
    </div>
  );

  const subScreen = subView && (
    <div key={subView} className="ui-push-in flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-14 items-center gap-1 pl-1 pr-2">
        <button
          type="button"
          aria-label="返回联系人"
          onClick={closeSubView}
          className="ui-press flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <ChevronLeft className="h-6 w-6" aria-hidden />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold">
          {SUB_VIEW_TITLE[subView]}
        </h2>
        {subView === 'discover' && (
          <Button
            variant="ghost"
            size="sm"
            className="ui-press whitespace-nowrap rounded-full"
            onClick={() => {
              setLoadingMore(false);
              setDiscoverOffset(nextOffsets.discover ?? 0);
              setLists((prev) => ({ ...prev, discover: null }));
              setReloadKey((key) => key + 1);
            }}
          >
            <RefreshCw className="h-4 w-4" aria-hidden /> 换一批
          </Button>
        )}
      </div>
      {subView === 'discover' && (
        <div className="flex items-center gap-2 px-4 pb-2">
          {searchField}
          <button
            type="button"
            aria-label="查找"
            disabled={searching || !query.trim()}
            onClick={() => void search()}
            className={iconButton}
          >
            <Search className="h-5 w-5" aria-hidden />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {subView === 'discover' &&
          searched &&
          (found ? (
            found.user.id === user.id ? (
              <Row
                username={found.user.username}
                displayName={found.user.displayName}
                status="这是你自己"
                mutual={false}
              />
            ) : (
              <Row
                username={found.user.username}
                displayName={found.user.displayName}
                mutual={found.following && found.followedBy}
                action={
                  found.following && found.followedBy ? (
                    <button
                      type="button"
                      aria-label="私聊"
                      className={iconButton}
                      onClick={() => startDm(found.user)}
                    >
                      <MessageCircle className="h-5 w-5" aria-hidden />
                    </button>
                  ) : found.following ? null : (
                    <button
                      type="button"
                      aria-label="关注"
                      className={iconButton}
                      disabled={busyId === found.user.id}
                      onClick={() => void toggle(found.user.id, false)}
                    >
                      <UserPlus className="h-5 w-5" aria-hidden />
                    </button>
                  )
                }
              />
            )
          ) : (
            // Same message whether the account does not exist or one of you
            // blocked the other. Telling them apart would make the block itself
            // detectable, and here that invites exactly the attention blocking
            // was meant to end.
            <ListMessage>未找到用户</ListMessage>
          ))}
        {subView === 'discover' && (
          <h3 className="px-4 pb-1 pt-3 text-[13px] font-medium text-[var(--text-faint)]">推荐</h3>
        )}
        {list}
        {errorLine}
      </div>
    </div>
  );

  const content = (
    <div
      role={presentation === 'dialog' ? 'dialog' : 'region'}
      aria-modal={presentation === 'dialog' || undefined}
      aria-label="交友"
      className={
        presentation === 'dialog'
          ? 'flex max-h-[min(680px,calc(100dvh-2rem))] w-[min(480px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] py-2 shadow-[var(--shadow-panel)]'
          : 'mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col md:py-4'
      }
    >
      {subScreen || listScreen}
      {presentation === 'dialog' ? (
        <div className="flex justify-end px-4 pt-2">
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </div>
      ) : null}
    </div>
  );
  return page ? content : <Overlay onDismiss={onClose}>{content}</Overlay>;
}

const WIDE_QUERY = '(min-width: 768px)';

// Module-level so useSyncExternalStore sees the same subscribe function every render;
// an inline arrow made it unsubscribe and resubscribe the media listener each render.
function subscribeWide(listener: () => void): () => void {
  return typeof window.matchMedia === 'function'
    ? subscribeMediaQuery(window.matchMedia(WIDE_QUERY), listener)
    : () => undefined;
}

function isWideNow(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia(WIDE_QUERY).matches;
}

/** Matches the md breakpoint the layout uses; without matchMedia (tests) it counts as wide. */
function useIsWide(): boolean {
  return useSyncExternalStore(subscribeWide, isWideNow, () => true);
}
