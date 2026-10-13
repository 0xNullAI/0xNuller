import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bluetooth,
  Bot,
  CheckCheck,
  ChevronRight,
  Compass,
  MapPin,
  MessageCircle,
  Search,
  SquarePen,
  UserRound,
  UserRoundPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { ModuleActions } from '@0xnullai/ui';
import {
  currentAuthUserId,
  markPrivateConversationRead,
  subscribeAuthChanges,
  selectAgentInboxConversation,
  type PrivateConversationSummary,
} from '@0xnullai/auth';
import { selectChatInboxConversation, type ChatInboxEntry } from '../../chat/src/inbox';
import {
  loadMoreAiConversations,
  loadMoreGroups,
  refreshInbox,
  useInbox,
  type InboxSnapshot,
} from './inbox-store';
import type { AuthUser } from '@0xnullai/auth';
import { useCharacterPhoto } from '@0xnullai/auth/appearance-react';
import { loadScenes, savedPromptKind } from '@0xnullai/scenes';
import { openCharacterChat, openSceneChat } from '@0xnullai/scenes/start-chat';
interface InboxRow {
  id: string;
  routeId: string;
  kind: 'ai' | 'dm' | 'group';
  title: string;
  preview: string;
  updatedAt: number;
  timeBasis?: string;
  unread: number | null;
  avatarPhotoId?: string | null;
  activate: () => void;
  markRead?: () => Promise<void>;
}

/** Chat-list time: clock time today, 昨天, month and day this year, full date before. */
export function formatInboxTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (timestamp >= startOfToday)
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (timestamp >= startOfToday - 86_400_000) return '昨天';
  if (date.getFullYear() === today.getFullYear())
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function characterName(id: string | undefined): string | null {
  if (!id) return null;
  return loadScenes().scenes.find((scene) => scene.id === id)?.name ?? null;
}

/** The URL identifies the open conversation; the inbox never guesses from a cached selection. */
export function currentInboxRowId(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search);
  const route =
    pathname === '/agent'
      ? { kind: 'ai', id: params.get('conversation') }
      : pathname === '/chat' && params.get('dm')
        ? { kind: 'dm', id: params.get('dm') }
        : pathname === '/chat'
          ? { kind: 'group', id: params.get('room') }
          : null;
  return route?.id ? `${route.kind}:${route.id}` : null;
}
function privateInboxRow(
  item: PrivateConversationSummary,
  accountId: string,
  onNavigate: (moduleId: string | null) => void,
): InboxRow {
  const id = item.id;
  return {
    id: `ai:${id}`,
    routeId: `ai:${id}`,
    kind: 'ai',
    // A conversation without its own title is named after its character (or, with no character,
    // its scene), like a contact.
    title:
      item.metadata.sessionTitle ||
      characterName(item.metadata.promptPresetId) ||
      characterName(item.metadata.sceneId) ||
      '未命名聊天',
    // Server-delivered companion messages carry a kind line; the row already says "AI".
    preview: item.preview?.replace(/^(AI主动消息|定时消息)\s*/, '') || '开始聊天',
    updatedAt: item.lastMessageAt ?? 0,
    timeBasis: '最近消息接收时间',
    unread: item.unread ?? null,
    avatarPhotoId: item.avatarPhotoId ?? null,
    ...(typeof item.lastSequence === 'number' && item.lastSequence > 0 && item.unread !== 0
      ? {
          markRead: async () => {
            if (currentAuthUserId() !== accountId) return;
            await markPrivateConversationRead(id, item.lastSequence);
          },
        }
      : {}),
    activate: () => {
      if (currentAuthUserId() !== accountId) return;
      selectAgentInboxConversation(id);
      onNavigate(`agent?conversation=${encodeURIComponent(id)}`);
    },
  };
}
/** Marks a row whose source could not be re-verified: no time, no count, no read action. */
function unconfirmedRow(row: InboxRow): InboxRow {
  return {
    ...row,
    updatedAt: 0,
    unread: null,
    preview: `${row.kind === 'group' ? '群聊' : '聊天'}暂未重新验证，请重试`,
    markRead: undefined,
  };
}

function humanInboxRow(
  item: ChatInboxEntry,
  accountId: string,
  onNavigate: (moduleId: string | null) => void,
): InboxRow {
  return {
    id: item.id,
    // A DM row is keyed by its private room, while its URL names the
    // peer account. They must not be compared as though they match.
    routeId:
      item.selection.kind === 'dm'
        ? `dm:${item.selection.peer.accountId ?? ''}`
        : `group:${item.selection.code}`,
    kind: item.kind,
    title: item.title,
    preview: item.preview ?? (item.kind === 'dm' ? '私人聊天' : '群聊'),
    updatedAt: item.updatedAt,
    unread: item.unread,
    markRead: item.markRead,
    activate: () => {
      if (currentAuthUserId() !== accountId) return;
      selectChatInboxConversation(item.selection);
      onNavigate(
        item.selection.kind === 'group'
          ? `chat?room=${encodeURIComponent(item.selection.code)}`
          : `chat?dm=${encodeURIComponent(item.selection.peer.accountId)}`,
      );
    },
  };
}

/** One list from both sources, newest first. */
function inboxRows(
  inbox: InboxSnapshot,
  accountId: string,
  onNavigate: (moduleId: string | null) => void,
): InboxRow[] {
  const rows: InboxRow[] = [];
  for (const item of inbox.ai.items) {
    // A conversation with no messages yet is not listed, as in other messaging apps;
    // it appears once something is said in it.
    if (item.deleted || item.lastSequence === 0) continue;
    const row = privateInboxRow(item, accountId, onNavigate);
    rows.push(inbox.ai.failed ? unconfirmedRow(row) : row);
  }
  for (const item of inbox.human.entries) {
    const row = humanInboxRow(item, accountId, onNavigate);
    rows.push(inbox.human.staleIds.has(item.id) ? unconfirmedRow(row) : row);
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/** What could not be read, once both sources have answered. */
function inboxError(inbox: InboxSnapshot): string {
  const missing: string[] = [];
  if (inbox.ai.failed) missing.push('AI 聊天');
  if (inbox.human.failed) missing.push('真人聊天');
  else {
    if (inbox.human.partialError) missing.push(inbox.human.partialError);
    if (inbox.human.entries.some((item) => item.summaryStatus === 'failed'))
      missing.push('部分群聊摘要');
  }
  return missing.length ? `部分聊天尚未读取：${missing.join('、')}。可重新加载。` : '';
}

/** The character's private portrait when one loads; otherwise the title's first letter. */
function InboxAvatar({
  title,
  photoId,
  size,
}: {
  title: string;
  photoId: string | null;
  size: string;
}) {
  const source = useCharacterPhoto(photoId);
  const [failed, setFailed] = useState<string | null>(null);
  const box = `flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--accent-soft)] text-base font-medium text-[var(--accent-text)] ${size}`;
  if (source && failed !== source)
    return (
      <span aria-hidden className={box}>
        <img
          src={source}
          alt=""
          onError={() => setFailed(source)}
          className="h-full w-full object-cover"
        />
      </span>
    );
  return (
    <span aria-hidden className={box}>
      {title.trim().slice(0, 1) || '·'}
    </span>
  );
}
/** One visible inbox. AI and human transports stay behind their respective owners. */
export function UnifiedInbox({
  user,
  onNavigate,
  onOpenAccount,
  onCreateRoom,
  onCreateCharacter,
  presentation = 'sidebar',
}: {
  user: AuthUser | null;
  onNavigate: (moduleId: string | null) => void;
  onOpenAccount: () => void;
  onCreateRoom: () => void;
  /** Opens the character editor; without it the guide only points to 发现. */
  onCreateCharacter?: () => void;
  presentation?: 'sidebar' | 'page';
}) {
  const accountId = user?.id ?? null;
  // Chat (private and group) requires a verified email; asking anyway only
  // turns that rule into a misleading "list unavailable, retry" error.
  const humanChatLocked = user?.emailVerified === false;
  const inbox = useInbox(accountId, humanChatLocked);
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [actionError, setActionError] = useState<{ accountId: string; message: string } | null>(
    null,
  );
  const refresh = useCallback(() => {
    setActionError(null);
    void refreshInbox();
  }, []);
  // Local view state belongs to one account: a different person must not inherit a search.
  useEffect(
    () =>
      subscribeAuthChanges(() => {
        setQuery('');
        setUnreadOnly(false);
        setNewChatOpen(false);
        setActionError(null);
      }),
    [],
  );
  const rows = useMemo(
    () => (accountId ? inboxRows(inbox, accountId, onNavigate) : []),
    [inbox, accountId, onNavigate],
  );
  const settled = inbox.ai.settled && inbox.human.settled;
  // Show whatever has arrived; the skeleton only stands in for a list with nothing yet.
  const loading = Boolean(accountId) && !settled && rows.length === 0;
  const error =
    (actionError?.accountId === accountId ? actionError.message : '') ||
    (settled ? inboxError(inbox) : '');
  const moreGroups = inbox.human.nextGroupCursor;
  const needle = query.trim().toLocaleLowerCase();
  const visibleRows = rows.filter(
    (row) =>
      (!unreadOnly || (row.unread ?? 0) > 0) &&
      (!needle || `${row.title} ${row.preview}`.toLocaleLowerCase().includes(needle)),
  );
  const currentRowId = currentInboxRowId(window.location.pathname, window.location.search);
  const loadMoreAi = () => {
    if (!accountId) return;
    void loadMoreAiConversations().catch(() => {
      if (currentAuthUserId() === accountId)
        setActionError({ accountId, message: '更多 AI 聊天读取失败，请重试。' });
    });
  };
  const startCharacter = (characterId: string) => {
    setNewChatOpen(false);
    void openCharacterChat(characterId).then((opened) => {
      if (opened) onNavigate('agent');
    });
  };
  const startScene = (sceneId: string) => {
    setNewChatOpen(false);
    void openSceneChat(sceneId).then((opened) => {
      if (opened) onNavigate('agent');
    });
  };
  const libraryCards = newChatOpen ? loadScenes().scenes : [];
  const characters = libraryCards.filter((scene) => savedPromptKind(scene) === 'character');
  const scenes = libraryCards.filter((scene) => savedPromptKind(scene) === 'scene');
  const newChatMenu = user ? (
    <NewChatMenu
      open={newChatOpen}
      onOpenChange={setNewChatOpen}
      characters={characters}
      scenes={scenes}
      onStartCharacter={startCharacter}
      onStartScene={startScene}
      onDiscover={() => {
        setNewChatOpen(false);
        onNavigate('market');
      }}
      onFindContact={() => {
        setNewChatOpen(false);
        onNavigate('people');
      }}
      onCreateRoom={() => {
        setNewChatOpen(false);
        onCreateRoom();
      }}
    />
  ) : null;
  const page = presentation === 'page';
  const fresh = inbox.fresh;
  return (
    <section
      aria-label="所有聊天"
      className={page ? 'h-full overflow-y-auto bg-[var(--bg)]' : 'pb-2'}
    >
      <div className={page ? 'mx-auto max-w-3xl' : ''}>
        {page ? (
          <>
            {/* Phone: the shell top bar already shows 「消息」, and ModuleActions moves the
                new-chat button there. Wider screens have no top-bar title, so show one here. */}
            <div className="hidden min-h-14 items-center px-4 pt-2 md:flex">
              <h1 className="min-w-0 flex-1 text-xl font-semibold">消息</h1>
            </div>
            {newChatMenu && <ModuleActions>{newChatMenu}</ModuleActions>}
          </>
        ) : (
          <div className="flex min-h-14 items-center gap-2 pl-4 pr-2">
            <h2 className="min-w-0 flex-1 text-[17px] font-semibold">消息</h2>
            {newChatMenu}
          </div>
        )}
        {user && (
          <div className="px-4 pb-2 pt-1">
            <label className="flex min-h-9 min-w-0 items-center gap-2 rounded-full bg-[var(--bg-soft)] px-3 text-[var(--text-faint)]">
              <Search className="h-4 w-4 shrink-0" aria-hidden />
              <input
                type="search"
                aria-label="搜索聊天"
                placeholder="搜索"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-h-0 min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-sm text-[var(--text)] shadow-none outline-none placeholder:text-[var(--text-faint)] focus:ring-0"
              />
            </label>
            <div
              role="group"
              aria-label="消息筛选"
              className="mt-2 inline-flex rounded-full bg-[var(--bg-soft)] p-0.5"
            >
              {[
                { label: '全部', selected: !unreadOnly, value: false },
                { label: '未读', selected: unreadOnly, value: true },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={option.selected}
                  onClick={() => setUnreadOnly(option.value)}
                  className={`ui-press min-h-7 rounded-full px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${option.selected ? 'bg-[var(--bg-elevated)] font-medium text-[var(--text)] shadow-[var(--shadow-soft)]' : 'text-[var(--text-soft)]'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {!user &&
        (page ? (
          <EmptyState text="登录后继续聊天" action="登录 / 注册" onAction={onOpenAccount} />
        ) : (
          <button
            type="button"
            onClick={onOpenAccount}
            className="ui-press-row w-full px-4 py-2 text-left text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
          >
            登录以查看跨端聊天记录
          </button>
        ))}
      <div className={page ? 'mx-auto max-w-3xl' : ''}>
        {error && (
          <p role="alert" className="px-4 py-2 text-sm text-[var(--danger)]">
            {error}
            <button type="button" onClick={refresh} className="ml-2 underline">
              重试
            </button>
          </p>
        )}
        {humanChatLocked && (
          <button
            type="button"
            onClick={onOpenAccount}
            className="ui-press-row w-full px-4 py-2 text-left text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
          >
            验证邮箱后可使用私聊和群聊
          </button>
        )}
        {loading && <InboxSkeleton />}
        {user &&
          !loading &&
          !error &&
          visibleRows.length === 0 &&
          (needle || unreadOnly || moreGroups ? (
            <p className="px-4 py-12 text-center text-sm text-[var(--text-faint)]">
              {needle
                ? moreGroups
                  ? '已加载的聊天没有匹配项，还有群聊可加载'
                  : '没有匹配的聊天'
                : unreadOnly
                  ? moreGroups
                    ? '已加载的聊天没有未读消息，还有群聊可加载'
                    : '没有未读消息'
                  : '还有群聊未加载'}
            </p>
          ) : (
            <WelcomeGuide
              onDiscover={() => onNavigate('market')}
              onCreateCharacter={onCreateCharacter}
              onConnectDevice={() => onNavigate('control')}
              onFindPeople={() => onNavigate('people')}
            />
          ))}
        {visibleRows.map((row) => {
          const current = currentRowId === row.routeId;
          const unread = row.unread !== null && row.unread > 0 ? row.unread : 0;
          return (
            <div
              key={row.id}
              className={`relative min-w-0 ${fresh?.has(row.id) ? 'ui-fade-up' : ''}`}
            >
              <button
                type="button"
                onClick={row.activate}
                aria-current={current ? 'page' : undefined}
                className={`ui-press-row flex min-h-[72px] w-full min-w-0 items-center gap-3 pl-4 text-left hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] ${current ? 'bg-[var(--accent-soft)]' : ''}`}
              >
                <InboxAvatar
                  title={row.title}
                  photoId={row.avatarPhotoId ?? null}
                  size="h-12 w-12"
                />
                {/* The divider sits on this block, so it starts after the avatar. */}
                <span className="flex min-h-[72px] min-w-0 flex-1 items-center gap-2 border-b-[0.5px] border-[var(--surface-border)] py-3 pr-4">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium leading-6">
                      {row.title}
                    </span>
                    <span className="block truncate text-sm leading-5 text-[var(--text-faint)]">
                      {/* Character chats read like any contact; only groups carry a tag. */}
                      {row.kind === 'group' && (
                        <span className="mr-1 text-[var(--text-soft)]">群聊</span>
                      )}
                      {row.preview}
                    </span>
                  </span>
                  <span className="flex shrink-0 self-start flex-col items-end gap-1.5 pt-0.5 text-xs tabular-nums text-[var(--text-faint)]">
                    {row.updatedAt ? (
                      <time dateTime={new Date(row.updatedAt).toISOString()} title={row.timeBasis}>
                        {formatInboxTime(row.updatedAt)}
                      </time>
                    ) : (
                      ''
                    )}
                    {!row.markRead && unread > 0 && <CountBadge count={unread} />}
                  </span>
                </span>
              </button>
              {row.markRead && (
                // A sibling of the row: a button inside a button is invalid markup.
                <button
                  type="button"
                  className="ui-press absolute right-3 top-[34px] flex min-h-6 min-w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  aria-label={`${row.title}标为已读`}
                  title="标为已读"
                  onClick={() => {
                    const owner = accountId;
                    void row.markRead!()
                      .then(refresh)
                      .catch(() => {
                        if (owner && currentAuthUserId() === owner)
                          setActionError({ accountId: owner, message: '标为已读失败，请重试。' });
                      });
                  }}
                >
                  {unread > 0 ? (
                    <CountBadge count={unread} />
                  ) : (
                    <CheckCheck className="h-3.5 w-3.5 text-[var(--text-faint)]" aria-hidden />
                  )}
                </button>
              )}
            </div>
          );
        })}
        {inbox.ai.nextCursor && (
          <button
            type="button"
            onClick={loadMoreAi}
            disabled={inbox.loadingMoreAi}
            className="ui-press mx-4 my-3 min-h-10 rounded-full px-3 text-sm text-[var(--accent-text)] hover:bg-[var(--bg-soft)] disabled:opacity-50"
          >
            {inbox.loadingMoreAi ? '正在加载…' : '加载更多 AI 聊天'}
          </button>
        )}
        {moreGroups && (
          <button
            type="button"
            onClick={() => void loadMoreGroups()}
            disabled={inbox.loadingMoreGroups}
            className="ui-press mx-4 my-3 min-h-10 rounded-full px-3 text-sm text-[var(--accent-text)] hover:bg-[var(--bg-soft)]"
          >
            {inbox.loadingMoreGroups
              ? '正在加载群聊…'
              : inbox.human.groupPageFailed
                ? '重试加载群聊'
                : '加载更多群聊'}
          </button>
        )}
      </div>
    </section>
  );
}

/** Small red unread count, the one unread signal in every list. */
function CountBadge({ count }: { count: number }) {
  return (
    <span className="min-w-[18px] rounded-full bg-[var(--danger)] px-1 text-center text-[11px] font-semibold leading-[18px] text-white">
      {count > 99 ? '99+' : count}
    </span>
  );
}

function EmptyState({
  text,
  action,
  onAction,
}: {
  text: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
      <span
        aria-hidden
        className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent-text)]"
      >
        <MessageCircle className="h-5 w-5" />
      </span>
      <p className="text-sm text-[var(--text-soft)]">{text}</p>
      <button
        type="button"
        onClick={onAction}
        className="ui-press min-h-9 rounded-full bg-[var(--accent)] px-5 text-sm font-medium text-[var(--button-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
      >
        {action}
      </button>
    </div>
  );
}

/**
 * What a new account sees instead of an empty list. Every AI chat starts from a character,
 * so the first step is choosing or writing one; devices and friends come after.
 */
function WelcomeGuide({
  onDiscover,
  onCreateCharacter,
  onConnectDevice,
  onFindPeople,
}: {
  onDiscover: () => void;
  onCreateCharacter?: () => void;
  onConnectDevice: () => void;
  onFindPeople: () => void;
}) {
  const steps: { icon: LucideIcon; title: string; detail: string; onClick: () => void }[] = [
    {
      icon: Compass,
      title: '挑一个角色',
      detail: '在发现里看看大家创建的角色',
      onClick: onDiscover,
    },
    ...(onCreateCharacter
      ? [
          {
            icon: UserRoundPlus,
            title: '创建我的角色',
            detail: '写下名字和性格，几分钟就好',
            onClick: onCreateCharacter,
          },
        ]
      : []),
    {
      icon: Bluetooth,
      title: '连接设备',
      detail: '郊狼或负鼠，强度上限由你决定',
      onClick: onConnectDevice,
    },
    { icon: Users, title: '找朋友', detail: '私聊和群聊，一起控制设备', onClick: onFindPeople },
  ];
  return (
    <section aria-label="开始使用" className="px-4 py-8">
      <span
        aria-hidden
        className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent-text)]"
      >
        <MessageCircle className="h-5 w-5" />
      </span>
      <h2 className="mt-3 text-base font-semibold">欢迎来到猫愿</h2>
      <p className="mt-1 text-sm text-[var(--text-soft)]">
        先选一个 AI 角色开始聊天。角色会记住你们聊过的事，聊天中也可以连接设备一起玩。
      </p>
      <div className="mt-5 overflow-hidden rounded-2xl bg-[var(--bg-elevated)]">
        {steps.map(({ icon: Icon, title, detail, onClick }) => (
          <button
            key={title}
            type="button"
            onClick={onClick}
            className="ui-press-row flex w-full items-center gap-3 border-b-[0.5px] border-[var(--surface-border)] px-4 py-3 text-left last:border-b-0 hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          >
            <Icon aria-hidden className="h-5 w-5 shrink-0 text-[var(--accent-text)]" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{title}</span>
              <span className="block truncate text-xs text-[var(--text-faint)]">{detail}</span>
            </span>
            <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
          </button>
        ))}
      </div>
    </section>
  );
}

function InboxSkeleton() {
  return (
    <div role="status" aria-label="正在读取聊天">
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} aria-hidden className="flex min-h-[72px] items-center gap-3 px-4">
          <span className="ui-skeleton h-12 w-12 shrink-0 rounded-full" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="ui-skeleton h-3.5 w-1/3" />
            <span className="ui-skeleton h-3 w-2/3" />
          </span>
        </div>
      ))}
    </div>
  );
}

const NEW_CHAT_MENU_ID = 'new-chat-options';

/** The top-bar new-chat icon and its menu. Escape or a press outside closes it. */
function NewChatMenu({
  open,
  onOpenChange,
  characters,
  scenes,
  onStartCharacter,
  onStartScene,
  onDiscover,
  onFindContact,
  onCreateRoom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  characters: { id: string; name: string; icon?: string }[];
  scenes: { id: string; name: string; icon?: string }[];
  onStartCharacter: (id: string) => void;
  /** A scene starts a chat in that place with no character. */
  onStartScene: (id: string) => void;
  onDiscover: () => void;
  onFindContact: () => void;
  onCreateRoom: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onOpenChange(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);
  const item =
    'flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-ctl)] px-3 text-left text-[15px] hover:bg-[var(--bg-soft)] focus-visible:bg-[var(--bg-soft)] focus-visible:outline-none';
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label="新聊天"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? NEW_CHAT_MENU_ID : undefined}
        className="ui-press flex h-11 w-11 items-center justify-center rounded-full text-[var(--text)] hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <SquarePen className="h-[22px] w-[22px]" aria-hidden />
      </button>
      {open && (
        <div
          id={NEW_CHAT_MENU_ID}
          role="menu"
          aria-label="选择聊天对象"
          className="ui-menu-in absolute right-0 top-full z-[var(--z-shell-popover)] mt-1 w-48 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1 shadow-[var(--shadow-panel)]"
        >
          <div className="max-h-56 overflow-y-auto">
            {characters.map((character) => (
              <button
                key={character.id}
                type="button"
                role="menuitem"
                onClick={() => onStartCharacter(character.id)}
                className={item}
              >
                <span className="flex h-[18px] w-[18px] items-center justify-center" aria-hidden>
                  {character.icon ?? <Bot className="h-[18px] w-[18px] text-[var(--text-soft)]" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{character.name}</span>
              </button>
            ))}
            {scenes.length > 0 && (
              <div role="group" aria-label="场景">
                <p className="px-3 pb-1 pt-2 text-xs text-[var(--text-faint)]" aria-hidden>
                  场景
                </p>
                {scenes.map((scene) => (
                  <button
                    key={scene.id}
                    type="button"
                    role="menuitem"
                    onClick={() => onStartScene(scene.id)}
                    className={item}
                  >
                    <span
                      className="flex h-[18px] w-[18px] items-center justify-center"
                      aria-hidden
                    >
                      {scene.icon ?? (
                        <MapPin className="h-[18px] w-[18px] text-[var(--text-soft)]" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{scene.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" role="menuitem" onClick={onDiscover} className={item}>
            <Compass className="h-[18px] w-[18px] text-[var(--text-soft)]" aria-hidden />
            {characters.length ? '找更多角色' : '找个 AI 角色聊天'}
          </button>
          <button type="button" role="menuitem" onClick={onFindContact} className={item}>
            <UserRound className="h-[18px] w-[18px] text-[var(--text-soft)]" aria-hidden />
            找联系人聊天
          </button>
          <button type="button" role="menuitem" onClick={onCreateRoom} className={item}>
            <Users className="h-[18px] w-[18px] text-[var(--text-soft)]" aria-hidden />
            创建群聊
          </button>
        </div>
      )}
    </div>
  );
}
