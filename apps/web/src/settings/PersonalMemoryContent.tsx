import { useEffect, useRef, useState } from 'react';
import {
  deletePersonalMemory,
  exportPersonalMemories,
  listPersonalMemories,
  savePersonalMemory,
  listHumanMemoryConversations,
  listHumanMemoryShares,
  listReceivedHumanMemories,
  setHumanMemoryShare,
  currentAuthUserId,
  subscribeAuthChanges,
  type HumanMemoryConversation,
  type HumanMemoryShare,
  type HumanMemoryPageCursor,
  type ReceivedHumanMemory,
  type PersonalMemory,
  type PersonalMemoryKind,
} from '@0xnullai/auth';
import { Button, Input, SegmentedControl, Switch } from '@0xnullai/ui';
import { Download, Pencil, Plus, Trash2 } from 'lucide-react';

const LABELS: Record<PersonalMemoryKind, string> = {
  preference: '我的偏好',
  person: '重要的人',
  event: '共同经历与约定',
  note: '其他记忆',
};
const SHORT_LABELS: Record<PersonalMemoryKind, string> = {
  preference: '偏好',
  person: '人物',
  event: '经历',
  note: '其他',
};
const TITLE_MAX = 100;
const CONTENT_MAX = 4000;

/** Relationship-scoped and AI-suggested memories cannot be shared into a human chat. */
function shareable(item: PersonalMemory): boolean {
  return item.scope !== 'relationship' && item.state !== 'suggested';
}

export function PersonalMemoryContent({
  initialChat,
}: {
  initialChat?: { kind: 'dm' | 'group'; id: string };
}) {
  const initialKind = initialChat?.kind;
  const initialId = initialChat?.id;
  const [items, setItems] = useState<PersonalMemory[] | null>(null);
  const [editing, setEditing] = useState<PersonalMemory | null>(null);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<PersonalMemoryKind>('preference');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<PersonalMemoryKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [conversations, setConversations] = useState<HumanMemoryConversation[] | null>(null);
  const [nextConversations, setNextConversations] = useState<HumanMemoryPageCursor | null>(null);
  const [selectedKey, setSelectedKey] = useState('');
  const [shares, setShares] = useState<Record<string, HumanMemoryShare> | null>(null);
  const [received, setReceived] = useState<ReceivedHumanMemory[] | null>(null);
  const [nextReceivedOffset, setNextReceivedOffset] = useState<number | null>(null);
  const [loadedChatKey, setLoadedChatKey] = useState('');
  const [chatRefresh, setChatRefresh] = useState(0);
  const selectedChat = conversations?.find((chat) => `${chat.kind}:${chat.id}` === selectedKey);
  const chatReady = !!selectedChat && loadedChatKey === selectedKey;
  const selectionRef = useRef(selectedKey);
  const accountEpochRef = useRef(0);

  useEffect(() => {
    selectionRef.current = selectedKey;
  }, [selectedKey]);

  useEffect(() => {
    let account = currentAuthUserId();
    return subscribeAuthChanges((user) => {
      if (user?.id === account) return;
      account = user?.id ?? null;
      accountEpochRef.current += 1;
      setBusy(false);
      setItems(null);
      setConversations(null);
      setNextConversations(null);
      setSelectedKey('');
      selectionRef.current = '';
      setShares(null);
      setReceived(null);
      setNextReceivedOffset(null);
      setLoadedChatKey('');
      setEditing(null);
      setTitle('');
      setContent('');
      setDraftId(crypto.randomUUID());
      setEditorOpen(false);
      setPendingDelete(null);
      setError(null);
      setNotice('');
      setRefresh((value) => value + 1);
    });
  }, []);

  useEffect(() => {
    let active = true;
    const epoch = accountEpochRef.current;
    void listPersonalMemories()
      .then(({ items: next }) => {
        if (active && accountEpochRef.current === epoch) setItems(next);
      })
      .catch((cause: unknown) => {
        if (active && accountEpochRef.current === epoch)
          setError(cause instanceof Error ? cause.message : '读取失败');
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    const epoch = accountEpochRef.current;
    void listHumanMemoryConversations()
      .then(({ conversations: next, next: cursor }) => {
        if (!active || accountEpochRef.current !== epoch) return;
        const initial =
          initialKind && initialId
            ? ({
                kind: initialKind,
                id: initialId,
                name: initialId,
              } satisfies HumanMemoryConversation)
            : null;
        const available =
          initial && !next.some((chat) => chat.kind === initial.kind && chat.id === initial.id)
            ? [initial, ...next]
            : next;
        setConversations(available);
        setNextConversations(cursor);
        setSelectedKey((key) => {
          if (initial) return `${initial.kind}:${initial.id}`;
          if (available.some((chat) => `${chat.kind}:${chat.id}` === key)) return key;
          return available[0] ? `${available[0].kind}:${available[0].id}` : '';
        });
      })
      .catch((cause: unknown) => {
        if (active && accountEpochRef.current === epoch)
          setError(cause instanceof Error ? cause.message : '读取聊天列表失败');
      });
    return () => {
      active = false;
    };
  }, [refresh, initialKind, initialId]);

  async function loadMoreConversations() {
    if (!nextConversations || busy) return;
    const epoch = accountEpochRef.current;
    setBusy(true);
    setError(null);
    try {
      const page = await listHumanMemoryConversations(nextConversations);
      if (accountEpochRef.current !== epoch) return;
      setConversations((current) => {
        const found = new Set((current ?? []).map((chat) => `${chat.kind}:${chat.id}`));
        return [
          ...(current ?? []),
          ...page.conversations.filter((chat) => !found.has(`${chat.kind}:${chat.id}`)),
        ];
      });
      if (page.conversations[0])
        setSelectedKey(
          (key) => key || `${page.conversations[0]!.kind}:${page.conversations[0]!.id}`,
        );
      setNextConversations(page.next);
    } catch (cause) {
      if (accountEpochRef.current === epoch)
        setError(cause instanceof Error ? cause.message : '加载更多聊天失败');
    } finally {
      if (accountEpochRef.current === epoch) setBusy(false);
    }
  }

  useEffect(() => {
    if (!selectedChat) return;
    let active = true;
    const epoch = accountEpochRef.current;
    const key = `${selectedChat.kind}:${selectedChat.id}`;
    void Promise.all([listHumanMemoryShares(selectedChat), listReceivedHumanMemories(selectedChat)])
      .then(([own, others]) => {
        if (!active || accountEpochRef.current !== epoch) return;
        setShares(Object.fromEntries(own.shares.map((grant) => [grant.memoryId, grant])));
        setReceived(others.items);
        setNextReceivedOffset(others.nextOffset);
        setLoadedChatKey(key);
      })
      .catch((cause: unknown) => {
        if (active && accountEpochRef.current === epoch)
          setError(cause instanceof Error ? cause.message : '读取共享记忆失败');
      });
    return () => {
      active = false;
    };
  }, [selectedChat, chatRefresh]);

  async function loadMoreReceived() {
    if (!selectedChat || !chatReady || nextReceivedOffset === null || busy) return;
    const epoch = accountEpochRef.current;
    const key = selectedKey;
    setBusy(true);
    setError(null);
    try {
      const page = await listReceivedHumanMemories(selectedChat, nextReceivedOffset);
      if (accountEpochRef.current !== epoch || selectionRef.current !== key) return;
      setReceived((current) => [...(current ?? []), ...page.items]);
      setNextReceivedOffset(page.nextOffset);
    } catch (cause) {
      if (accountEpochRef.current === epoch)
        setError(cause instanceof Error ? cause.message : '加载共享记忆失败');
    } finally {
      if (accountEpochRef.current === epoch) setBusy(false);
    }
  }

  useEffect(() => {
    const onFocus = () => {
      setLoadedChatKey('');
      setChatRefresh((value) => value + 1);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  function clearEditor() {
    setDraftId(crypto.randomUUID());
    setEditing(null);
    setTitle('');
    setContent('');
    setKind('preference');
    setEditorOpen(false);
  }

  function startEdit(item: PersonalMemory) {
    setEditing(item);
    setKind(item.kind);
    setTitle(item.title);
    setContent(item.content);
    setNotice('');
    setPendingDelete(null);
    setEditorOpen(true);
  }

  async function save() {
    const epoch = accountEpochRef.current;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const { item } = await savePersonalMemory({
        id: editing?.id ?? draftId,
        version: editing?.version ?? 0,
        kind,
        title,
        content,
      });
      if (accountEpochRef.current !== epoch) return;
      setItems((current) => [item, ...(current ?? []).filter((entry) => entry.id !== item.id)]);
      setLoadedChatKey('');
      setChatRefresh((value) => value + 1);
      clearEditor();
      setNotice('已保存');
    } catch (cause) {
      if (accountEpochRef.current === epoch)
        setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      if (accountEpochRef.current === epoch) setBusy(false);
    }
  }

  async function remove(item: PersonalMemory) {
    const epoch = accountEpochRef.current;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await deletePersonalMemory(item.id, item.version);
      if (accountEpochRef.current !== epoch) return;
      setItems((current) => current?.filter((entry) => entry.id !== item.id) ?? []);
      setLoadedChatKey('');
      setChatRefresh((value) => value + 1);
      if (editing?.id === item.id) clearEditor();
      setPendingDelete(null);
      setNotice('已删除');
    } catch (cause) {
      if (accountEpochRef.current === epoch)
        setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      if (accountEpochRef.current === epoch) setBusy(false);
    }
  }

  async function toggleShare(item: PersonalMemory) {
    if (!selectedChat || !shares || !chatReady) return;
    const epoch = accountEpochRef.current;
    const key = selectedKey;
    const previous = shares[item.id];
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const { share } = await setHumanMemoryShare(selectedChat, item, {
        enabled: !previous?.enabled,
        version: previous?.version ?? 0,
      });
      if (accountEpochRef.current !== epoch || selectionRef.current !== key) return;
      setShares((current) => (current ? { ...current, [item.id]: share } : current));
      setNotice(share.enabled ? '已向这段聊天共享' : '已撤销共享');
    } catch (cause) {
      if (accountEpochRef.current === epoch)
        setError(cause instanceof Error ? cause.message : '更新共享失败');
    } finally {
      if (accountEpochRef.current === epoch) setBusy(false);
    }
  }

  async function exportAll() {
    const epoch = accountEpochRef.current;
    setBusy(true);
    setError(null);
    try {
      const data = await exportPersonalMemories();
      if (accountEpochRef.current !== epoch) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `0xnuller-memories-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice('已导出全部记忆');
    } catch (cause) {
      if (accountEpochRef.current === epoch)
        setError(cause instanceof Error ? cause.message : '导出失败');
    } finally {
      if (accountEpochRef.current === epoch) setBusy(false);
    }
  }

  const needle = query.trim().toLowerCase();
  const visible = (items ?? []).filter(
    (item) =>
      (filter === 'all' || item.kind === filter) &&
      (!needle ||
        item.title.toLowerCase().includes(needle) ||
        item.content.toLowerCase().includes(needle)),
  );
  const shareableItems = (items ?? []).filter(shareable);

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="我的记忆" className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 text-sm font-semibold">
            我的记忆
            {items ? (
              <span className="ml-1.5 font-normal text-[var(--text-faint)]">{items.length}</span>
            ) : null}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || items === null}
            onClick={() => {
              clearEditor();
              setEditorOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            添加
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void exportAll()}>
            <Download className="h-4 w-4" />
            导出
          </Button>
        </div>
        <p className="text-xs text-[var(--text-faint)]">只有你能看到，除非在下方共享给某个聊天。</p>

        {error && (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
          >
            <span className="min-w-0">{error}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setError(null);
                setItems(null);
                clearEditor();
                setRefresh((value) => value + 1);
              }}
            >
              重新读取
            </Button>
          </div>
        )}
        {notice && (
          <p role="status" className="text-xs text-[var(--text-soft)]">
            {notice}
          </p>
        )}

        {editorOpen && items !== null && (
          <form
            aria-label={editing ? '编辑记忆' : '新记忆'}
            className="flex flex-col gap-2 rounded-[var(--radius-sm)] bg-[var(--bg-elevated)] p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <SegmentedControl
              label="记忆类型"
              className="w-fit"
              value={kind}
              disabled={busy}
              onChange={setKind}
              options={(Object.keys(LABELS) as PersonalMemoryKind[]).map(
                (value) => [value, SHORT_LABELS[value]] as const,
              )}
            />
            <Input
              aria-label="记忆标题"
              placeholder="标题，例如：我希望的称呼"
              value={title}
              maxLength={TITLE_MAX}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
            <textarea
              aria-label="记忆内容"
              placeholder="写下你希望 AI 记住的内容"
              value={content}
              maxLength={CONTENT_MAX}
              disabled={busy}
              onChange={(event) => setContent(event.target.value)}
              rows={4}
              className="w-full rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm"
            />
            <div className="flex items-center gap-2">
              <span className="flex-1 text-xs text-[var(--text-faint)]">
                {content.length}/{CONTENT_MAX}
              </span>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={clearEditor}>
                取消
              </Button>
              <Button type="submit" size="sm" disabled={busy || !title.trim() || !content.trim()}>
                {busy ? '处理中…' : editing ? '保存修改' : '添加记忆'}
              </Button>
            </div>
          </form>
        )}

        {items === null ? (
          <p className="text-xs text-[var(--text-faint)]">
            {error ? '暂时无法读取记忆' : '正在读取记忆…'}
          </p>
        ) : items.length === 0 ? (
          !editorOpen && (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <p className="text-sm text-[var(--text-faint)]">还没有个人记忆。</p>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  clearEditor();
                  setEditorOpen(true);
                }}
              >
                添加第一条
              </Button>
            </div>
          )
        ) : (
          <>
            <div className="flex items-center gap-2">
              <SegmentedControl
                label="记忆类型筛选"
                value={filter}
                onChange={setFilter}
                options={[
                  ['all', '全部'],
                  ...(Object.keys(SHORT_LABELS) as PersonalMemoryKind[]).map(
                    (value) => [value, SHORT_LABELS[value]] as const,
                  ),
                ]}
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索"
                aria-label="搜索记忆"
                className="h-9 min-w-0 flex-1 text-sm"
              />
            </div>
            {visible.length === 0 ? (
              <p className="py-4 text-center text-sm text-[var(--text-faint)]">没有匹配的记忆</p>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--surface-border)]">
                {visible.map((item) => {
                  const open = expanded.has(item.id);
                  const long = item.content.length > 80 || item.content.includes('\n');
                  return (
                    <li key={item.id} className="flex flex-col gap-1 py-3">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded-full bg-[var(--bg-strong)] px-2 py-0.5 text-[11px] text-[var(--text-soft)]">
                              {SHORT_LABELS[item.kind]}
                            </span>
                            {item.state === 'suggested' && (
                              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px]">
                                AI 建议
                              </span>
                            )}
                            <p className="min-w-0 break-words text-sm font-medium">{item.title}</p>
                          </div>
                          <p
                            className={`mt-1 whitespace-pre-wrap break-words text-sm text-[var(--text-soft)] ${open ? '' : 'line-clamp-2'}`}
                          >
                            {item.content}
                          </p>
                          {long && (
                            <button
                              type="button"
                              className="mt-0.5 text-xs text-[var(--accent)]"
                              onClick={() =>
                                setExpanded((current) => {
                                  const next = new Set(current);
                                  if (next.has(item.id)) next.delete(item.id);
                                  else next.add(item.id);
                                  return next;
                                })
                              }
                            >
                              {open ? '收起' : '展开'}
                            </button>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center">
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`编辑 ${item.title}`}
                            onClick={() => startEdit(item)}
                            className="ui-press rounded-full p-2 text-[var(--text-faint)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`删除 ${item.title}`}
                            onClick={() =>
                              setPendingDelete((current) => (current === item.id ? null : item.id))
                            }
                            className="ui-press rounded-full p-2 text-[var(--text-faint)] hover:bg-[var(--bg-soft)] hover:text-[var(--danger)]"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      {pendingDelete === item.id && (
                        <div className="flex items-center justify-end gap-2 text-xs">
                          <span className="text-[var(--text-soft)]">删除后 AI 不再记得这条</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => setPendingDelete(null)}
                          >
                            取消
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy}
                            aria-label={`确认删除 ${item.title}`}
                            onClick={() => void remove(item)}
                          >
                            删除
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>

      {items !== null && (
        <section aria-label="共享到真人聊天" className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-semibold">共享到真人聊天</h3>
            <p className="mt-1 text-xs text-[var(--text-faint)]">
              群内现有和之后加入的成员都能看到；撤销后，对方已看过的内容无法收回。
            </p>
          </div>
          {conversations === null ? (
            <p className="text-xs text-[var(--text-faint)]">正在核验可用聊天…</p>
          ) : conversations.length === 0 && !nextConversations ? (
            <p className="text-xs text-[var(--text-faint)]">暂无可共享的真人聊天。</p>
          ) : (
            <>
              {conversations.length > 0 && (
                <select
                  aria-label="选择记忆共享聊天"
                  value={selectedKey}
                  onChange={(event) => {
                    selectionRef.current = event.target.value;
                    setSelectedKey(event.target.value);
                  }}
                  className="w-full min-w-0 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm"
                >
                  {conversations.map((chat) => (
                    <option key={`${chat.kind}:${chat.id}`} value={`${chat.kind}:${chat.id}`}>
                      {chat.kind === 'dm' ? '私聊' : '群聊'} · {chat.name || chat.id}
                    </option>
                  ))}
                </select>
              )}
              {nextConversations && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-fit"
                  disabled={busy}
                  onClick={() => void loadMoreConversations()}
                >
                  加载更早的聊天
                </Button>
              )}
              {selectedChat && (
                <>
                  {!chatReady || !shares ? (
                    <p className="text-xs text-[var(--text-faint)]">正在读取…</p>
                  ) : shareableItems.length === 0 ? (
                    <p className="text-xs text-[var(--text-faint)]">没有可共享的记忆。</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-[var(--surface-border)]">
                      {shareableItems.map((item) => {
                        const on = !!shares[item.id]?.enabled;
                        return (
                          <li key={item.id} className="flex items-center gap-3 py-2.5">
                            <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                            <Switch
                              label={`共享 ${item.title}`}
                              checked={on}
                              disabled={busy}
                              onCheckedChange={() => void toggleShare(item)}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="flex items-center justify-between gap-2 pt-2">
                    <h4 className="text-xs font-semibold text-[var(--text-soft)]">
                      对方共享给我的
                    </h4>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setLoadedChatKey('');
                        setChatRefresh((value) => value + 1);
                      }}
                    >
                      刷新
                    </Button>
                  </div>
                  {!chatReady || received === null ? (
                    <p className="text-xs text-[var(--text-faint)]">正在读取…</p>
                  ) : received.length === 0 ? (
                    <p className="text-xs text-[var(--text-faint)]">暂无收到的记忆。</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-[var(--surface-border)]">
                      {received.map((entry) => (
                        <li key={`${entry.ownerId}:${entry.memory.id}`} className="py-2.5 text-sm">
                          <p className="font-medium">
                            {entry.memory.title}
                            <span className="ml-1.5 font-normal text-[var(--text-faint)]">
                              来自 {entry.ownerName}
                            </span>
                          </p>
                          <p className="mt-0.5 whitespace-pre-wrap break-words text-[var(--text-soft)]">
                            {entry.memory.content}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                  {chatReady && nextReceivedOffset !== null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-fit"
                      disabled={busy}
                      onClick={() => void loadMoreReceived()}
                    >
                      加载更多
                    </Button>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
