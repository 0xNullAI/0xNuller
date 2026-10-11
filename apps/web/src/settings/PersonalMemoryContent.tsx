import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Button, Input, SegmentedControl } from '@0xnullai/ui';
import { Download, Plus, Trash2, Users } from 'lucide-react';
import { AdvancedSubpage } from './SettingsAdvanced';
import { SelectRow, SettingsGroup, SettingsPage, SettingsRow, SwitchRow } from './settings-list';

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
  const [query, setQuery] = useState('');
  /** list → one memory (new or existing) → back; received shows what others shared. */
  const [page, setPage] = useState<'list' | 'edit' | 'chats'>(initialChat ? 'chats' : 'list');
  const [confirmDelete, setConfirmDelete] = useState(false);
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
      setPage('list');
      setConfirmDelete(false);
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

  // Stable: the subpage header re-registers whenever its back handler changes.
  const clearEditor = useCallback(() => {
    setDraftId(crypto.randomUUID());
    setEditing(null);
    setTitle('');
    setContent('');
    setKind('preference');
    setConfirmDelete(false);
    setPage('list');
  }, []);
  const backToList = useCallback(() => setPage('list'), []);

  function startNew() {
    setDraftId(crypto.randomUUID());
    setEditing(null);
    setTitle('');
    setContent('');
    setKind('preference');
    setNotice('');
    setConfirmDelete(false);
    setPage('edit');
  }

  function startEdit(item: PersonalMemory) {
    setEditing(item);
    setKind(item.kind);
    setTitle(item.title);
    setContent(item.content);
    setNotice('');
    setConfirmDelete(false);
    setPage('edit');
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

  const needle = query.trim().toLowerCase();
  const visible = (items ?? []).filter(
    (item) =>
      !needle ||
      item.title.toLowerCase().includes(needle) ||
      item.content.toLowerCase().includes(needle),
  );

  const errorBanner = error && (
    <div
      role="alert"
      className="flex items-center justify-between gap-2 rounded-2xl bg-[var(--danger-soft)] px-4 py-2 text-sm text-[var(--danger)]"
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
  );

  const chatPicker =
    conversations && conversations.length > 0 ? (
      <SelectRow
        label="聊天"
        value={selectedKey}
        onChange={(key) => {
          selectionRef.current = key;
          setSelectedKey(key);
        }}
        options={conversations.map((chat) => ({
          value: `${chat.kind}:${chat.id}`,
          label: `${chat.kind === 'dm' ? '私聊' : '群聊'} · ${chat.name || chat.id}`,
        }))}
      />
    ) : null;

  const moreChats = nextConversations ? (
    <SettingsRow label="加载更早的聊天" onClick={() => void loadMoreConversations()} />
  ) : null;

  if (page === 'chats')
    return (
      <AdvancedSubpage title="聊天中的共享" onBack={backToList}>
        <SettingsPage>
          {errorBanner}
          {conversations === null ? (
            <p className="px-4 text-xs text-[var(--text-faint)]">正在核验可用聊天…</p>
          ) : conversations.length === 0 && !nextConversations ? (
            <p className="px-4 text-xs text-[var(--text-faint)]">暂无可共享的真人聊天。</p>
          ) : (
            <SettingsGroup>
              {chatPicker}
              {moreChats}
            </SettingsGroup>
          )}
          {selectedChat && items !== null && (
            <SettingsGroup
              label="我共享给这个聊天的"
              footer="群里现有和之后加入的成员都能看到；撤销后，对方已看过的内容无法收回。"
            >
              {items.filter(shareable).length === 0 ? (
                <SettingsRow label="没有可共享的记忆" />
              ) : (
                items
                  .filter(shareable)
                  .map((item) => (
                    <SwitchRow
                      key={item.id}
                      label={item.title}
                      checked={!!shares?.[item.id]?.enabled}
                      disabled={busy || !chatReady || !shares}
                      onCheckedChange={() => void toggleShare(item)}
                    />
                  ))
              )}
            </SettingsGroup>
          )}
          {selectedChat && (
            <SettingsGroup label="对方共享给我的">
              {!chatReady || received === null ? (
                <SettingsRow label="正在读取…" />
              ) : received.length === 0 ? (
                <SettingsRow label="暂无收到的记忆" />
              ) : (
                received.map((entry) => (
                  <SettingsRow
                    key={`${entry.ownerId}:${entry.memory.id}`}
                    label={entry.memory.title}
                    detail={`${entry.ownerName} · ${entry.memory.content}`}
                  />
                ))
              )}
              {chatReady && nextReceivedOffset !== null && (
                <SettingsRow label="加载更多" onClick={() => void loadMoreReceived()} />
              )}
            </SettingsGroup>
          )}
        </SettingsPage>
      </AdvancedSubpage>
    );

  if (page === 'edit' && items !== null) {
    const canShare = editing !== null && shareable(editing);
    const sharedHere = canShare && !!shares?.[editing.id]?.enabled;
    return (
      <AdvancedSubpage title={editing ? '编辑记忆' : '新记忆'} onBack={clearEditor}>
        <SettingsPage>
          {errorBanner}
          <form
            aria-label={editing ? '编辑记忆' : '新记忆'}
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <SettingsGroup footer={`${content.length}/${CONTENT_MAX}`}>
              <div className="flex flex-col gap-3 p-4">
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
                  rows={5}
                  className="w-full rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm"
                />
              </div>
            </SettingsGroup>
            <Button
              type="submit"
              className="w-fit"
              disabled={busy || !title.trim() || !content.trim()}
            >
              {busy ? '处理中…' : editing ? '保存修改' : '添加记忆'}
            </Button>
          </form>

          {canShare && conversations && (conversations.length > 0 || nextConversations) && (
            <SettingsGroup
              label="共享到真人聊天"
              footer="群里现有和之后加入的成员都能看到；撤销后，对方已看过的内容无法收回。"
            >
              {chatPicker}
              {moreChats}
              {selectedChat && (
                <SwitchRow
                  label="共享给这个聊天"
                  checked={sharedHere}
                  disabled={busy || !chatReady || !shares}
                  onCheckedChange={() => void toggleShare(editing)}
                />
              )}
            </SettingsGroup>
          )}

          {editing && (
            <SettingsGroup>
              {confirmDelete ? (
                <>
                  <SettingsRow
                    label="确认删除"
                    tone="danger"
                    onClick={() => void remove(editing)}
                  />
                  <SettingsRow label="取消" onClick={() => setConfirmDelete(false)} />
                </>
              ) : (
                <SettingsRow
                  icon={Trash2}
                  tone="danger"
                  label="删除这条记忆"
                  onClick={() => setConfirmDelete(true)}
                />
              )}
            </SettingsGroup>
          )}
        </SettingsPage>
      </AdvancedSubpage>
    );
  }

  return (
    <SettingsPage>
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索记忆"
          aria-label="搜索记忆"
          className="h-10 min-w-0 flex-1 text-sm"
        />
        <Button variant="secondary" disabled={busy || items === null} onClick={startNew}>
          <Plus className="h-4 w-4" />
          添加
        </Button>
      </div>
      {errorBanner}
      {notice && (
        <p role="status" className="px-4 text-xs text-[var(--text-soft)]">
          {notice}
        </p>
      )}
      {items === null ? (
        <p className="px-4 text-xs text-[var(--text-faint)]">
          {error ? '暂时无法读取记忆' : '正在读取记忆…'}
        </p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <p className="text-sm text-[var(--text-faint)]">还没有个人记忆。</p>
          <Button variant="secondary" size="sm" disabled={busy} onClick={startNew}>
            添加第一条
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--text-faint)]">没有匹配的记忆</p>
      ) : (
        (Object.keys(LABELS) as PersonalMemoryKind[]).map((group) => {
          const rows = visible.filter((item) => item.kind === group);
          if (rows.length === 0) return null;
          return (
            <SettingsGroup key={group} label={LABELS[group]}>
              {rows.map((item) => (
                <SettingsRow
                  key={item.id}
                  label={item.title}
                  detail={item.content}
                  value={item.state === 'suggested' ? 'AI 建议' : undefined}
                  onClick={() => startEdit(item)}
                />
              ))}
            </SettingsGroup>
          );
        })
      )}
      {items !== null && (
        <SettingsGroup>
          <SettingsRow icon={Users} label="聊天中的共享" onClick={() => setPage('chats')} />
          <SettingsRow
            icon={Download}
            label="导出全部记忆"
            onClick={() => (busy ? undefined : void exportAll())}
          />
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
