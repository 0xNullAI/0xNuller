import { BookOpen, Compass, Cpu, MessageCircle, UserRound, Users } from 'lucide-react';
import {
  Avatar,
  useClaimedSidebarSections,
  useSidebarContainerRef,
  type SidebarSectionId,
} from '@0xnullai/ui';
import { avatarSrc, type AuthUser } from '@0xnullai/auth';
import { UnifiedInbox } from './UnifiedInbox';
import { UnreadBadge } from './UnreadBadge';

interface NavRailProps {
  activeId: string | null;
  peopleActive: boolean;
  settingsActive: boolean;
  onNavigate: (moduleId: string | null) => void;
  user: AuthUser | null;
  creditBalance: number | null;
  unreadMessages: number;
  onOpenAccount: () => void;
  onOpenContacts: () => void;
  onOpenDocs: () => void;
}

/**
 * Wide-screen primary navigation: one narrow column holding only the five places a person
 * can go. Lists (conversations, contacts) live in their own column or page, never stacked
 * under these entries, so the first column always answers "where am I".
 */
export function NavRail({
  activeId,
  peopleActive,
  settingsActive,
  onNavigate,
  user,
  creditBalance,
  unreadMessages,
  onOpenAccount,
  onOpenContacts,
  onOpenDocs,
}: NavRailProps) {
  const navigation = [
    {
      label: '消息',
      Icon: MessageCircle,
      current: !settingsActive && (activeId === 'agent' || activeId === 'chat'),
      run: () => onNavigate(null),
      badge: unreadMessages,
    },
    {
      label: '联系人',
      Icon: Users,
      current: !settingsActive && peopleActive,
      run: onOpenContacts,
    },
    {
      label: '发现',
      Icon: Compass,
      // Games are reached from 发现, so they keep it highlighted.
      current: !settingsActive && (activeId === 'market' || activeId === 'playground'),
      run: () => onNavigate('market'),
    },
    {
      label: '设备',
      Icon: Cpu,
      current: !settingsActive && activeId === 'control',
      run: () => onNavigate('control'),
    },
  ];
  const item = (current: boolean) =>
    `ui-press flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-xl text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${current ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]' : 'text-[var(--text-faint)] hover:bg-[var(--bg-soft)]'}`;

  return (
    <aside className="flex h-full min-h-0 w-full flex-col items-stretch gap-1 border-r-[0.5px] border-[var(--surface-border)] bg-[var(--bg-elevated)] px-1.5 py-3">
      <nav aria-label="主要功能" className="flex flex-col gap-1">
        {navigation.map(({ label, Icon, current, run, badge }) => (
          <button
            key={label}
            type="button"
            onClick={run}
            aria-current={current ? 'page' : undefined}
            aria-label={badge ? `${label}，${badge} 条未读` : undefined}
            className={item(current)}
          >
            <span className="relative">
              <Icon className="h-5 w-5 shrink-0" />
              {badge ? <UnreadBadge count={badge} /> : null}
            </span>
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1" />
      <button type="button" onClick={onOpenDocs} aria-label="帮助与文档" className={item(false)}>
        <BookOpen className="h-5 w-5 shrink-0" />
        帮助
      </button>
      <button
        type="button"
        onClick={onOpenAccount}
        aria-label="打开我的设置"
        aria-current={settingsActive ? 'page' : undefined}
        title={user && creditBalance !== null ? `${creditBalance} Credit` : undefined}
        className={item(settingsActive)}
      >
        <Avatar
          name={user?.displayName ?? null}
          username={user?.username}
          src={avatarSrc(user?.avatarUrl)}
          size={24}
        />
        我的
      </button>
    </aside>
  );
}

function SidebarSectionSlot({ id, title }: { id: SidebarSectionId; title: string }) {
  const ref = useSidebarContainerRef(id);
  return (
    <section className="border-b border-[var(--surface-border)] px-2 py-3">
      <h2 className="px-2 pb-1 text-xs font-medium text-[var(--text-faint)]">{title}</h2>
      <div ref={ref} />
    </section>
  );
}

/** The wide-screen conversation list, shown only next to an open conversation. */
export function InboxColumn({
  user,
  onNavigate,
  onOpenAccount,
  onCreateRoom,
}: {
  user: AuthUser | null;
  onNavigate: (moduleId: string | null) => void;
  onOpenAccount: () => void;
  onCreateRoom: () => void;
}) {
  const sections = useClaimedSidebarSections();
  return (
    <aside
      aria-label="消息列表"
      className="flex h-full min-h-0 w-full flex-col border-r-[0.5px] border-[var(--surface-border)] bg-[var(--bg-elevated)]"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sections.some((section) => section.id === 'pinned') && (
          <SidebarSectionSlot id="pinned" title="置顶" />
        )}
        <UnifiedInbox
          user={user}
          onNavigate={onNavigate}
          onOpenAccount={onOpenAccount}
          onCreateRoom={onCreateRoom}
        />
      </div>
    </aside>
  );
}

export type MobileTab = 'messages' | 'people' | 'discover' | 'device' | 'me';

const MOBILE_TABS: { id: MobileTab; label: string; Icon: typeof MessageCircle }[] = [
  { id: 'messages', label: '消息', Icon: MessageCircle },
  { id: 'people', label: '联系人', Icon: Users },
  { id: 'discover', label: '发现', Icon: Compass },
  { id: 'device', label: '设备', Icon: Cpu },
  { id: 'me', label: '我的', Icon: UserRound },
];

/**
 * Phone bottom navigation. The active tab is the only accent on the bar; the rest stay
 * faint, and a hairline is the only separation from the content above.
 */
export function MobileTabBar({
  current,
  unreadMessages,
  onSelect,
}: {
  current: MobileTab | null;
  unreadMessages: number;
  onSelect: (tab: MobileTab) => void;
}) {
  return (
    <nav
      aria-label="手机主导航"
      className="flex shrink-0 border-t-[0.5px] border-[var(--surface-border)] bg-[var(--bg-elevated)] pb-[env(safe-area-inset-bottom)]"
    >
      {MOBILE_TABS.map(({ id, label, Icon }) => {
        const active = current === id;
        const badge = id === 'messages' ? unreadMessages : 0;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            aria-current={active ? 'page' : undefined}
            aria-label={badge ? `${label}，${badge} 条未读` : undefined}
            className={`ui-press flex h-[var(--tabbar-h)] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] ${active ? 'font-medium text-[var(--accent-text)]' : 'text-[var(--text-faint)]'}`}
          >
            <span className="relative">
              <Icon className="h-6 w-6" strokeWidth={active ? 2.25 : 1.75} aria-hidden />
              {badge ? <UnreadBadge count={badge} /> : null}
            </span>
            {label}
          </button>
        );
      })}
    </nav>
  );
}
