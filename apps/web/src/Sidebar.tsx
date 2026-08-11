import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  PanelLeftClose,
  Settings,
  UserRound,
  Users,
  BookOpen,
  Globe2,
  LogIn,
  Plus,
} from 'lucide-react';
import { Avatar, useClaimedSidebarSections, useSidebarContainerRef } from '@0xnullai/ui';
import type { SidebarSectionId } from '@0xnullai/ui';
import {
  avatarSrc,
  dmConversations,
  openDirectMessage,
  type AuthUser,
  type DmConversation,
} from '@0xnullai/auth';
import { MODULES } from './routes';

/**
 * The sidebar. It is the only vertical bar in the app, with the content area to
 * its right — the top bar has been removed.
 *
 * Three regions, each placed where it is for a reason:
 * - **Top** is the current app name; click it to switch. That is "where am I" and
 *   "where do I go", so it sits where the eye starts.
 * - **Middle** is pinned / conversations / rooms. Modules register their own list
 *   items here and the shell only handles sectioning and ordering. Scenes are not
 *   here — a scene is "which persona this session uses", which belongs to the
 *   content area rather than to navigation.
 * - **Bottom** is the account. Clicking it gives three items: account / app
 *   settings / docs. Settings has this one entry point and no other.
 *
 * The stop button is **not** here. It is at the far left of the device bar at the
 * top of the content area — that bar only appears once a device is connected, and
 * stop has to sit right next to the information "something is attached to me".
 */

interface SidebarProps {
  activeId: string | null;
  onNavigate: (moduleId: string | null) => void;
  user: AuthUser | null;
  onOpenAccount: () => void;
  onOpenContacts: () => void;
  onOpenSettings: () => void;
  onOpenDocs: () => void;
  onCreateRoom: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function AppSwitcherButton({
  activeId,
  onNavigate,
}: {
  activeId: string | null;
  onNavigate: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = MODULES.find((m) => m.id === activeId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-ctl)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="truncate text-[15px] font-bold tracking-tight">
          {current?.label ?? '0xNuller'}
        </span>
        <ChevronDown
          className={
            'h-3.5 w-3.5 shrink-0 text-[var(--text-faint)] transition-transform ' +
            (open ? 'rotate-180' : '')
          }
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-[calc(100%+4px)] z-[var(--z-shell)] w-[220px] rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1.5 shadow-[var(--shadow-panel)]"
        >
          {MODULES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onNavigate(m.id);
                setOpen(false);
              }}
              className={
                'flex w-full items-center gap-2 rounded-[var(--radius-ctl)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-soft)] ' +
                (m.id === activeId ? 'bg-[var(--accent-soft)]' : '')
              }
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{m.label}</span>
                <span className="block truncate text-xs text-[var(--text-faint)]">{m.blurb}</span>
              </span>
              {m.id === activeId && <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountButton({
  user,
  onOpenAccount,
  onOpenContacts,
  onOpenSettings,
  onOpenDocs,
}: {
  user: AuthUser | null;
  onOpenAccount: () => void;
  onOpenContacts: () => void;
  onOpenSettings: () => void;
  onOpenDocs: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items = [
    {
      key: 'account',
      icon: user ? <UserRound className="h-4 w-4" /> : <LogIn className="h-4 w-4" />,
      label: user ? '账户' : '登录 / 注册',
      run: onOpenAccount,
    },
    // Only when signed in. Contacts are the one item here that cannot do
    // anything without an account, and offering it signed out would put a dead
    // entry in a menu that is otherwise fully usable anonymously.
    ...(user
      ? [
          {
            key: 'contacts',
            icon: <Users className="h-4 w-4" />,
            label: '联系人',
            run: onOpenContacts,
          },
        ]
      : []),
    {
      key: 'settings',
      icon: <Settings className="h-4 w-4" />,
      label: '软件设置',
      run: onOpenSettings,
    },
    { key: 'docs', icon: <BookOpen className="h-4 w-4" />, label: '说明', run: onOpenDocs },
  ];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-2 rounded-[var(--radius-ctl)] px-2 py-2 text-left transition-colors hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Avatar
          name={user?.displayName ?? null}
          username={user?.username}
          src={avatarSrc(user?.avatarUrl)}
          size={26}
        />
        <span className="min-w-0 flex-1 truncate text-sm">{user?.displayName ?? '未登录'}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+4px)] left-0 z-[var(--z-shell)] w-[200px] rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1.5 shadow-[var(--shadow-panel)]"
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.run();
              }}
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-ctl)] px-2.5 py-2 text-left text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
            >
              <span className="shrink-0 text-[var(--text-faint)]">{it.icon}</span>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The container for one section. Module list items portal in here; the title and
 *  the spacing stay under the shell's control. */
function SidebarSectionSlot({ id, title }: { id: SidebarSectionId; title: string }) {
  const ref = useSidebarContainerRef(id);
  return (
    <section className="mt-2 border-t border-[var(--surface-border)] pt-3 first:mt-0 first:border-t-0 first:pt-0">
      <h2 className="px-2 pb-1.5 text-sm font-semibold text-[var(--text-soft)]">{title}</h2>
      <div ref={ref} />
    </section>
  );
}

/**
 * Useful first-run destinations while Agent and Chat have not mounted yet.
 *
 * The real modules claim these same section ids once opened and portal their
 * complete, stateful lists into the shell. Until then, keeping the two primary
 * entry points here makes the sidebar useful on the home page and in modules
 * such as Control that do not own conversations or rooms.
 */
function DefaultSidebarDestination({
  id,
  onNavigate,
  user,
  onOpenAccount,
  onCreateRoom,
}: {
  id: 'conversations' | 'direct' | 'rooms';
  onNavigate: (moduleId: string | null) => void;
  user: AuthUser | null;
  onOpenAccount: () => void;
  onCreateRoom: () => void;
}) {
  const [directMessages, setDirectMessages] = useState<DmConversation[] | null>(null);
  useEffect(() => {
    if (id !== 'direct' || !user) return;
    let alive = true;
    void dmConversations().then((result) => {
      if (alive) setDirectMessages(result?.conversations ?? []);
    });
    return () => {
      alive = false;
    };
  }, [id, user]);
  const itemClass =
    'flex w-full items-center gap-2 rounded-[var(--radius-ctl)] px-2 py-1.5 text-left text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

  if (id === 'conversations') {
    return (
      <section className="mt-2 border-t border-[var(--surface-border)] pt-3 first:mt-0 first:border-t-0 first:pt-0">
        <h2 className="px-2 pb-1.5 text-sm font-semibold text-[var(--text-soft)]">对话</h2>
        <button type="button" onClick={() => onNavigate('agent')} className={itemClass}>
          <Plus className="h-4 w-4 shrink-0" />
          新对话
        </button>
      </section>
    );
  }

  if (!user) {
    return id === 'rooms' ? (
      <section className="mt-2 border-t border-[var(--surface-border)] pt-3 first:mt-0 first:border-t-0 first:pt-0">
        <h2 className="px-2 pb-1.5 text-sm font-semibold text-[var(--text-soft)]">Chat</h2>
        <button type="button" onClick={onOpenAccount} className={itemClass}>
          <LogIn className="h-4 w-4 shrink-0" />
          登录后使用
        </button>
      </section>
    ) : null;
  }

  if (id === 'direct') {
    return (
      <section className="mt-2 border-t border-[var(--surface-border)] pt-3 first:mt-0 first:border-t-0 first:pt-0">
        <h2 className="px-2 pb-1.5 text-sm font-semibold text-[var(--text-soft)]">私聊</h2>
        {directMessages === null ? (
          <p className="px-2 py-2 text-xs text-[var(--text-faint)]">加载中…</p>
        ) : directMessages.length === 0 ? (
          <p className="px-2 py-2 text-xs text-[var(--text-faint)]">
            在联系人中找到互相关注的人开始私聊
          </p>
        ) : (
          directMessages.map((peer) => (
            <button
              key={peer.id}
              type="button"
              onClick={() => {
                openDirectMessage(peer.id);
                onNavigate('chat');
              }}
              className={itemClass}
            >
              <Users className="h-4 w-4 shrink-0" />
              <span className="truncate">{peer.displayName || peer.username}</span>
            </button>
          ))
        )}
      </section>
    );
  }

  return (
    <section className="mt-2 border-t border-[var(--surface-border)] pt-3 first:mt-0 first:border-t-0 first:pt-0">
      <h2 className="px-2 pb-1.5 text-sm font-semibold text-[var(--text-soft)]">房间</h2>
      <button type="button" onClick={onCreateRoom} className={itemClass}>
        <Plus className="h-4 w-4 shrink-0" />
        建房间
      </button>
      <button type="button" onClick={() => onNavigate('chat')} className={itemClass}>
        <Globe2 className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">公开大厅</span>
        <span className="text-[10px] text-[var(--text-faint)]">常驻</span>
      </button>
    </section>
  );
}

const SIDEBAR_SECTION_ORDER: SidebarSectionId[] = ['pinned', 'conversations', 'direct', 'rooms'];

export function Sidebar({
  activeId,
  onNavigate,
  user,
  onOpenAccount,
  onOpenContacts,
  onOpenSettings,
  onOpenDocs,
  onCreateRoom,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) {
  const sections = useClaimedSidebarSections();

  if (collapsed) {
    return (
      <aside className="flex h-full w-full flex-col items-center gap-2 border-r border-[var(--surface-border)] bg-[var(--bg-elevated)] py-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="展开侧边栏"
          className="rounded-[var(--radius-ctl)] p-2 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
        >
          <PanelLeftClose className="h-4 w-4 rotate-180" />
        </button>
        <div className="mt-auto">
          <Avatar
            name={user?.displayName ?? null}
            username={user?.username}
            src={avatarSrc(user?.avatarUrl)}
            size={26}
          />
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-[var(--surface-border)] bg-[var(--bg-elevated)]">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-3 pb-1">
        <AppSwitcherButton activeId={activeId} onNavigate={onNavigate} />
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="收起侧边栏"
          className="shrink-0 rounded-[var(--radius-ctl)] p-2 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {SIDEBAR_SECTION_ORDER.map((id) => {
          const section = sections.find((candidate) => candidate.id === id);
          if (section) {
            return <SidebarSectionSlot key={id} id={id} title={section.title} />;
          }
          if (id === 'conversations' || id === 'direct' || id === 'rooms') {
            return (
              <DefaultSidebarDestination
                key={id}
                id={id}
                onNavigate={onNavigate}
                user={user}
                onOpenAccount={onOpenAccount}
                onCreateRoom={onCreateRoom}
              />
            );
          }
          return null;
        })}
      </div>

      <div className="shrink-0 border-t border-[var(--surface-border)] p-2">
        <AccountButton
          user={user}
          onOpenAccount={onOpenAccount}
          onOpenContacts={onOpenContacts}
          onOpenSettings={onOpenSettings}
          onOpenDocs={onOpenDocs}
        />
      </div>
    </aside>
  );
}
