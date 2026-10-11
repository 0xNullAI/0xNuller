import { useCallback, useEffect, useState, useRef } from 'react';
import { CheckCheck, Plus, Search } from 'lucide-react';
import {
  currentAuthUserId,
  markPrivateConversationRead,
  subscribeAuthChanges,
  listPrivateConversationSummaries,
  selectAgentInboxConversation,
  requestNewAgentInboxConversation,
} from '@0xnullai/auth';
import {
  loadChatInboxDisplayWithStatus,
  selectChatInboxConversation,
  type ChatInboxEntry,
} from '../../chat/src/inbox';
import type { AuthUser } from '@0xnullai/auth';
import { useCharacterPhoto } from '@0xnullai/auth/appearance-react';
import { loadScenes } from '@0xnullai/scenes';
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
  item: Awaited<ReturnType<typeof listPrivateConversationSummaries>>['items'][number],
  accountId: string,
  onNavigate: (moduleId: string | null) => void,
): InboxRow {
  const id = item.id;
  return {
    id: `ai:${id}`,
    routeId: `ai:${id}`,
    kind: 'ai',
    // A conversation without its own title is named after its character, like a contact.
    title:
      item.metadata.sessionTitle || characterName(item.metadata.promptPresetId) || '未命名聊天',
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
  const box = `flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--accent-soft)] text-sm ${size}`;
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
  presentation = 'sidebar',
}: {
  user: AuthUser | null;
  onNavigate: (moduleId: string | null) => void;
  onOpenAccount: () => void;
  onCreateRoom: () => void;
  presentation?: 'sidebar' | 'page';
}) {
  const accountId = user?.id ?? null;
  const [result, setResult] = useState<{
    accountId: string;
    rows: InboxRow[];
    error: string;
    aiNextCursor: string | null;
    groupNextCursor: string | null;
    groupPageFailed: boolean;
  } | null>(null);
  const authEpoch = useRef(0);
  const loadedAiPages = useRef<{ accountId: string | null; count: number }>({
    accountId: null,
    count: 1,
  });
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMoreGroups, setLoadingMoreGroups] = useState(false);
  const [groupPages, setGroupPages] = useState(1);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    if (!accountId) return;
    if (loadedAiPages.current.accountId !== accountId)
      loadedAiPages.current = { accountId, count: 1 };
    let active = true;
    const epoch = authEpoch.current;
    const pageCount = loadedAiPages.current.count;
    Promise.allSettled([
      (async () => {
        const items: Awaited<ReturnType<typeof listPrivateConversationSummaries>>['items'] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < pageCount; page++) {
          if (!active || epoch !== authEpoch.current || currentAuthUserId() !== accountId)
            return { items: [], nextCursor: null };
          const result = await listPrivateConversationSummaries({
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          for (const item of result.items) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            items.push(item);
          }
          if (!result.nextCursor) return { items, nextCursor: null };
          cursor = result.nextCursor;
        }
        return { items, nextCursor: cursor ?? null };
      })(),
      loadChatInboxDisplayWithStatus(groupPages),
    ])
      .then(([ai, human]) => {
        if (!active || epoch !== authEpoch.current || currentAuthUserId() !== accountId) return;
        const results: InboxRow[] = [];
        if (ai.status === 'fulfilled')
          for (const item of ai.value.items) {
            // A conversation with no messages yet is not listed, as in other messaging apps;
            // it appears once something is said in it.
            if (item.deleted || item.lastSequence === 0) continue;
            results.push(privateInboxRow(item, accountId, onNavigate));
          }
        if (human.status === 'fulfilled')
          for (const item of human.value.entries as ChatInboxEntry[]) {
            results.push({
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
            });
          }
        results.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
        const missing: string[] = [];
        if (ai.status === 'rejected') missing.push('AI 聊天');
        if (human.status === 'rejected') missing.push('真人聊天');
        else {
          if (human.value.partialError) missing.push(human.value.partialError);
          if (human.value.entries.some((item) => item.summaryStatus === 'failed'))
            missing.push('部分群聊摘要');
        }
        const groupPageFailed = human.status === 'rejected' || Boolean(human.value.groupPageFailed);
        const dmLoadFailed = human.status === 'rejected' || Boolean(human.value.dmLoadFailed);
        const aiLoadFailed = ai.status === 'rejected';
        setResult((previous) => {
          if (
            previous?.accountId === accountId &&
            (groupPageFailed || dmLoadFailed || aiLoadFailed)
          ) {
            const seen = new Set(results.map((row) => row.id));
            for (const row of previous.rows) {
              const failed =
                row.kind === 'group'
                  ? groupPageFailed
                  : row.kind === 'dm'
                    ? dmLoadFailed
                    : aiLoadFailed;
              if (!failed || seen.has(row.id)) continue;
              results.push({
                ...row,
                updatedAt: 0,
                unread: null,
                preview: `${row.kind === 'group' ? '群聊' : '聊天'}暂未重新验证，请重试`,
                markRead: undefined,
              });
            }
            results.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
          }
          return {
            accountId,
            rows: results,
            error: missing.length ? `部分聊天尚未读取：${missing.join('、')}。可重新加载。` : '',
            aiNextCursor: ai.status === 'fulfilled' ? ai.value.nextCursor : null,
            groupNextCursor:
              human.status === 'fulfilled' ? (human.value.nextGroupCursor ?? null) : null,
            groupPageFailed,
          };
        });
      })
      .finally(() => {
        if (active && epoch === authEpoch.current) setLoadingMoreGroups(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, revision, onNavigate, groupPages]);
  useEffect(() => {
    let pending: number | null = null;
    const scheduleRefresh = () => {
      if (pending !== null) window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        pending = null;
        refresh();
      }, 300);
    };
    const timer = window.setInterval(scheduleRefresh, 30_000);
    window.addEventListener('focus', scheduleRefresh);
    window.addEventListener('0xnullai:conversation-updated', scheduleRefresh);
    const unsubscribe = subscribeAuthChanges(() => {
      authEpoch.current += 1;
      setResult(null);
      setQuery('');
      setUnreadOnly(false);
      setNewChatOpen(false);
      setLoadingMore(false);
      setLoadingMoreGroups(false);
      setGroupPages(1);
      loadedAiPages.current = { accountId: null, count: 1 };
      refresh();
    });
    return () => {
      if (pending !== null) window.clearTimeout(pending);
      window.clearInterval(timer);
      window.removeEventListener('focus', scheduleRefresh);
      window.removeEventListener('0xnullai:conversation-updated', scheduleRefresh);
      unsubscribe();
    };
  }, [refresh]);
  const rows = accountId === result?.accountId ? result.rows : [];
  const error = accountId === result?.accountId ? result.error : '';
  const loading = Boolean(accountId && result?.accountId !== accountId);
  const moreGroups = accountId === result?.accountId ? result.groupNextCursor : null;
  const needle = query.trim().toLocaleLowerCase();
  const visibleRows = rows.filter(
    (row) =>
      (!unreadOnly || (row.unread ?? 0) > 0) &&
      (!needle || `${row.title} ${row.preview}`.toLocaleLowerCase().includes(needle)),
  );
  const currentRowId = currentInboxRowId(window.location.pathname, window.location.search);
  const loadMoreAi = async () => {
    const cursor = result?.accountId === accountId ? result.aiNextCursor : null;
    if (!accountId || !cursor || loadingMore) return;
    const source = result;
    const epoch = authEpoch.current;
    setLoadingMore(true);
    try {
      const page = await listPrivateConversationSummaries({ limit: 100, cursor });
      if (epoch !== authEpoch.current || currentAuthUserId() !== accountId) return;
      if (loadedAiPages.current.accountId === accountId) loadedAiPages.current.count += 1;
      setResult((current) => {
        if (!current || current !== source) return current;
        const seen = new Set(current.rows.map((row) => row.id));
        const nextRows = [...current.rows];
        for (const item of page.items) {
          if (item.deleted || seen.has(`ai:${item.id}`)) continue;
          seen.add(`ai:${item.id}`);
          nextRows.push(privateInboxRow(item, accountId, onNavigate));
        }
        nextRows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
        return {
          ...current,
          rows: nextRows,
          aiNextCursor: page.nextCursor && page.nextCursor !== cursor ? page.nextCursor : null,
        };
      });
    } catch {
      if (epoch === authEpoch.current && currentAuthUserId() === accountId)
        setResult((current) =>
          current && current === source
            ? { ...current, error: '更多 AI 聊天读取失败，请重试。' }
            : current,
        );
    } finally {
      if (epoch === authEpoch.current) setLoadingMore(false);
    }
  };
  const startAi = () => {
    if (!accountId) {
      onOpenAccount();
      return;
    }
    requestNewAgentInboxConversation();
    setNewChatOpen(false);
    onNavigate('agent');
  };
  const newChatButton = (
    <button
      type="button"
      onClick={() => setNewChatOpen((open) => !open)}
      aria-expanded={newChatOpen}
      aria-controls="new-chat-options"
      className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 text-sm font-medium text-[var(--button-text)] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
    >
      <Plus className="h-4 w-4" aria-hidden />
      新聊天
    </button>
  );
  return (
    <section
      aria-label="所有聊天"
      className={presentation === 'page' ? 'h-full overflow-y-auto bg-[var(--bg)]' : 'px-2 py-2'}
    >
      <div className={presentation === 'page' ? 'mx-auto max-w-3xl px-3 pt-2' : ''}>
        {presentation === 'sidebar' && (
          <div className="flex min-h-12 items-center gap-2 px-1">
            <h2 className="min-w-0 flex-1 px-1 text-base font-semibold">
              {presentation === 'sidebar' ? '消息' : ''}
            </h2>
            {user && newChatButton}
          </div>
        )}
        {user && newChatOpen && (
          <div
            id="new-chat-options"
            role="group"
            aria-label="选择聊天对象"
            className="rounded-xl border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1"
          >
            <button
              type="button"
              onClick={startAi}
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-soft)]"
            >
              与 AI 聊天
            </button>
            <button
              type="button"
              onClick={() => {
                setNewChatOpen(false);
                onNavigate('people');
              }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-soft)]"
            >
              找联系人聊天
            </button>
            <button
              type="button"
              onClick={() => {
                setNewChatOpen(false);
                onCreateRoom();
              }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-soft)]"
            >
              创建群聊
            </button>
          </div>
        )}
        {user && (
          <>
            <div className="mt-1 flex items-center gap-2">
              <label className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-[var(--bg-soft)] px-3 text-[var(--text-faint)]">
                <Search className="h-4 w-4 shrink-0" />
                <input
                  type="search"
                  aria-label="搜索聊天"
                  placeholder="搜索聊天"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="min-h-0 min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-sm text-[var(--text)] shadow-none outline-none placeholder:text-[var(--text-faint)] focus:ring-0"
                />
              </label>
              {presentation === 'page' && newChatButton}
            </div>
            <div
              className="flex gap-1 border-b border-[var(--surface-border)] py-2"
              aria-label="消息筛选"
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
                  className={`min-h-9 rounded-lg px-3 text-sm ${option.selected ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]' : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)]'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {!user &&
        (presentation === 'page' ? (
          <div className="flex flex-col items-center gap-3 px-4 py-20 text-center">
            <span
              aria-hidden
              className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-2xl"
            >
              💬
            </span>
            <h2 className="text-base font-semibold">登录后继续聊天</h2>
            <p className="max-w-64 text-sm text-[var(--text-soft)]">聊天记录随账号跨端同步。</p>
            <button
              type="button"
              onClick={onOpenAccount}
              className="rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-medium text-[var(--button-text)]"
            >
              登录 / 注册
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onOpenAccount}
            className="rounded px-2 py-2 text-left text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
          >
            登录以查看跨端聊天记录
          </button>
        ))}
      <div className={presentation === 'page' ? 'mx-auto max-w-3xl px-3' : ''}>
        {error && (
          <p role="alert" className="px-2 py-2 text-sm text-[var(--danger)]">
            {error}
            <button type="button" onClick={refresh} className="ml-2 underline">
              重试
            </button>
          </p>
        )}
        {loading && (
          <p role="status" className="px-2 text-sm">
            正在读取聊天…
          </p>
        )}
        {user && !loading && !error && visibleRows.length === 0 && (
          <div className="px-2 py-12 text-center text-sm text-[var(--text-faint)]">
            {needle
              ? moreGroups
                ? '已加载的聊天没有匹配项，还有群聊可加载'
                : '没有匹配的聊天'
              : unreadOnly
                ? moreGroups
                  ? '已加载的聊天没有未读消息，还有群聊可加载'
                  : '没有未读消息'
                : moreGroups
                  ? '还有群聊未加载'
                  : '暂无聊天'}
          </div>
        )}
        {visibleRows.map((row) => (
          <div key={row.id} className="relative min-w-0">
            <button
              type="button"
              onClick={row.activate}
              aria-current={currentRowId === row.routeId ? 'page' : undefined}
              className={`flex w-full min-w-0 items-center gap-3 rounded-xl text-left hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${currentRowId === row.routeId ? 'bg-[var(--accent-soft)]' : ''} ${presentation === 'page' ? 'min-h-[72px] border-b border-[var(--surface-border)] px-2 py-3' : 'min-h-16 px-2 py-2'}`}
            >
              <InboxAvatar
                title={row.title}
                photoId={row.avatarPhotoId ?? null}
                size={presentation === 'page' ? 'h-12 w-12' : 'h-9 w-9'}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{row.title}</span>
                <span className="block truncate text-xs text-[var(--text-faint)]">
                  {/* Character chats read like any contact; only groups carry a tag. */}
                  {row.kind === 'group' && (
                    <span className="mr-1 font-medium text-[var(--text-soft)]">群聊</span>
                  )}
                  {row.preview}
                </span>
              </span>
              <span className="mt-1 flex shrink-0 self-start flex-col items-end gap-1 text-xs text-[var(--text-faint)]">
                {row.updatedAt ? (
                  <time dateTime={new Date(row.updatedAt).toISOString()} title={row.timeBasis}>
                    {formatInboxTime(row.updatedAt)}
                  </time>
                ) : (
                  ''
                )}
                {!row.markRead && row.unread !== null && row.unread > 0 && (
                  <span className="rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[var(--button-text)]">
                    {row.unread > 99 ? '99+' : row.unread}
                  </span>
                )}
              </span>
            </button>
            {row.markRead && (
              <button
                type="button"
                className="absolute bottom-1 right-2 flex min-h-6 min-w-6 items-center justify-center rounded-full bg-[var(--accent)] px-1.5 text-[11px] text-[var(--button-text)] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
                aria-label={`${row.title}标为已读`}
                title="标为已读"
                onClick={() => {
                  const epoch = authEpoch.current;
                  void row.markRead!()
                    .then(refresh)
                    .catch(() => {
                      if (epoch === authEpoch.current)
                        setResult((value) =>
                          value ? { ...value, error: '标为已读失败，请重试。' } : value,
                        );
                    });
                }}
              >
                {row.unread !== null && row.unread > 0 ? (
                  row.unread > 99 ? (
                    '99+'
                  ) : (
                    row.unread
                  )
                ) : (
                  <CheckCheck className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
            )}
          </div>
        ))}
        {accountId === result?.accountId && result.aiNextCursor && (
          <button
            type="button"
            onClick={() => void loadMoreAi()}
            disabled={loadingMore}
            className="mx-2 my-3 min-h-10 rounded-lg px-3 text-sm text-[var(--accent)] hover:bg-[var(--bg-soft)] disabled:opacity-50"
          >
            {loadingMore ? '正在加载…' : '加载更多 AI 聊天'}
          </button>
        )}
        {accountId === result?.accountId && moreGroups && (
          <button
            type="button"
            onClick={() => {
              setLoadingMoreGroups(true);
              if (result.groupPageFailed) refresh();
              else setGroupPages((count) => count + 1);
            }}
            disabled={loadingMoreGroups}
            className="mx-2 my-3 min-h-10 rounded-lg px-3 text-sm text-[var(--accent)] hover:bg-[var(--bg-soft)]"
          >
            {loadingMoreGroups
              ? '正在加载群聊…'
              : result.groupPageFailed
                ? '重试加载群聊'
                : '加载更多群聊'}
          </button>
        )}
      </div>
    </section>
  );
}
