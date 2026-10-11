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
import { Button, Input } from '@0xnullai/ui';

const LABELS: Record<PersonalMemoryKind, string> = {
  preference: '我的偏好',
  person: '重要的人',
  event: '共同经历与约定',
  note: '其他记忆',
};

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

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-[var(--text-soft)]">
          记录你的偏好、重要的人和共同约定。默认仅自己可见；你可以下方逐条开放给指定真人聊天。
        </p>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void exportAll()}>
          导出
        </Button>
      </div>
      {error && (
        <div role="alert" className="text-sm text-[var(--danger)]">
          {error}
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
      {items === null ? (
        <p className="text-xs">{error ? '暂时无法读取记忆' : '正在读取记忆…'}</p>
      ) : (
        <>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {items.length === 0 && (
              <p className="text-xs text-[var(--text-faint)]">还没有个人记忆。</p>
            )}
            {items.map((item) => (
              <div
                key={item.id}
                className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-2"
              >
                <p className="break-words text-sm font-medium">{item.title}</p>
                <p className="text-xs text-[var(--text-faint)]">{LABELS[item.kind]}</p>
                <p className="whitespace-pre-wrap break-words text-sm">{item.content}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`编辑 ${item.title}`}
                    onClick={() => {
                      setEditing(item);
                      setKind(item.kind);
                      setTitle(item.title);
                      setContent(item.content);
                      setNotice('');
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`删除 ${item.title}`}
                    onClick={() => void remove(item)}
                  >
                    删除
                  </Button>
                  {chatReady &&
                    shares &&
                    item.scope !== 'relationship' &&
                    item.state !== 'suggested' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`${shares[item.id]?.enabled ? '撤销共享' : '共享'} ${item.title}`}
                        onClick={() => void toggleShare(item)}
                      >
                        {shares[item.id]?.enabled ? '撤销共享' : '共享到当前聊天'}
                      </Button>
                    )}
                </div>
              </div>
            ))}
          </div>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="block text-sm">
              记忆类型
              <select
                aria-label="记忆类型"
                value={kind}
                disabled={busy}
                onChange={(event) => setKind(event.target.value as PersonalMemoryKind)}
                className="ml-2 rounded border border-[var(--surface-border)] bg-[var(--surface)] p-1"
              >
                {Object.entries(LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Input
              aria-label="记忆标题"
              placeholder="例如：我希望的称呼"
              value={title}
              maxLength={100}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
            <textarea
              aria-label="记忆内容"
              placeholder="写下你希望保留的内容"
              value={content}
              maxLength={4000}
              disabled={busy}
              onChange={(event) => setContent(event.target.value)}
              rows={3}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-transparent p-2 text-sm"
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy || !title.trim() || !content.trim()}>
                {busy ? '处理中…' : editing ? '保存修改' : '添加记忆'}
              </Button>
              {editing && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={clearEditor}>
                  取消编辑
                </Button>
              )}
            </div>
          </form>
          <section className="space-y-2 border-t border-[var(--surface-border)] pt-3">
            <h3 className="text-sm font-semibold">真人聊天记忆共享</h3>
            <p className="text-xs text-[var(--text-soft)]">
              每条记忆只向你选中的私聊或群聊开放。群聊中的当前及之后加入的成员都可能看到。修改或删除记忆、撤销共享后，之后的读取会使用最新状态；对方已经看过或复制的内容无法收回。
            </p>
            {conversations === null ? (
              <p className="text-xs">正在核验可用聊天…</p>
            ) : conversations.length === 0 && !nextConversations ? (
              <p className="text-xs">暂无可共享的真人聊天。</p>
            ) : (
              <>
                {conversations.length > 0 && (
                  <label className="block text-sm">
                    选择聊天
                    <select
                      aria-label="选择记忆共享聊天"
                      value={selectedKey}
                      onChange={(event) => {
                        selectionRef.current = event.target.value;
                        setSelectedKey(event.target.value);
                      }}
                      className="mt-1 block w-full min-w-0 rounded border border-[var(--surface-border)] bg-[var(--surface)] p-1"
                    >
                      {conversations.map((chat) => (
                        <option key={`${chat.kind}:${chat.id}`} value={`${chat.kind}:${chat.id}`}>
                          {chat.kind === 'dm' ? '私聊' : '群聊'} · {chat.name || chat.id}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {nextConversations && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void loadMoreConversations()}
                  >
                    加载更早的聊天
                  </Button>
                )}
                {selectedChat && (
                  <p className="text-xs text-[var(--text-soft)]">
                    在上方每条个人记忆旁选择共享或撤销。
                  </p>
                )}
                {selectedChat && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold">这段聊天中别人共享给我的记忆</h4>
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
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                      {!chatReady || received === null ? (
                        <p className="text-xs">正在读取…</p>
                      ) : received.length === 0 ? (
                        <p className="text-xs text-[var(--text-faint)]">暂无收到的记忆。</p>
                      ) : (
                        received.map((entry) => (
                          <div
                            key={`${entry.ownerId}:${entry.memory.id}`}
                            className="rounded border border-[var(--surface-border)] p-2 text-sm"
                          >
                            <p className="font-medium">
                              {entry.memory.title} · {entry.ownerName}
                            </p>
                            <p className="whitespace-pre-wrap break-words">
                              {entry.memory.content}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                    {chatReady && nextReceivedOffset !== null && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void loadMoreReceived()}
                      >
                        加载更多共享记忆
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
