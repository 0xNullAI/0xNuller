import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  PanelLeftClose,
  Settings,
  UserRound,
  BookOpen,
  LogIn,
} from 'lucide-react';
import { useClaimedSidebarSections, useSidebarContainerRef } from '@0xnullai/ui';
import type { SidebarSectionId } from '@0xnullai/ui';
import type { AuthUser } from '@0xnullai/auth';
import { MODULES, DOCS_ROUTE } from './routes';
import { Avatar } from './Avatar';

/**
 * 侧边栏。全局只有这一条竖栏，右边是内容区——顶部横栏已经取消。
 *
 * 三个区域，各自的位置是有理由的：
 * - **顶部**是当前应用名，点开切换。这是「我在哪」和「去哪」，所以在视线起点。
 * - **中间**是置顶 / 对话 / 房间。模块把自己的列表项注册进来，外壳只管分区与排序。
 *   场景不在这里——它是「当前会话用哪个人设」，属于内容区而不是导航。
 * - **底部**是账户。点开是账户 / 软件设置 / 说明三项。设置只有这一个入口。
 *
 * 停止按钮**不在这里**。它在内容区顶部的设备栏最左——那条栏只在连上设备后出现，
 * 而停止必须紧挨着「有什么东西连着我」这个信息。
 */

interface SidebarProps {
  activeId: string | null;
  onNavigate: (moduleId: string | null) => void;
  user: AuthUser | null;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
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
        className="flex w-full min-w-0 items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
          className="absolute left-0 top-[calc(100%+4px)] z-[var(--z-shell)] w-[220px] rounded-[14px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1.5 shadow-[var(--shadow-panel)]"
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
                'flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-soft)] ' +
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
  onOpenSettings,
  onNavigate,
}: {
  user: AuthUser | null;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onNavigate: (id: string | null) => void;
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
    {
      key: 'settings',
      icon: <Settings className="h-4 w-4" />,
      label: '软件设置',
      run: onOpenSettings,
    },
    {
      key: 'docs',
      icon: <BookOpen className="h-4 w-4" />,
      label: DOCS_ROUTE.label,
      run: () => onNavigate(DOCS_ROUTE.id),
    },
  ];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-left transition-colors hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Avatar name={user?.username ?? null} size={26} />
        <span className="min-w-0 flex-1 truncate text-sm">{user?.displayName ?? '未登录'}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+4px)] left-0 z-[var(--z-shell)] w-[200px] rounded-[14px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1.5 shadow-[var(--shadow-panel)]"
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
              className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
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

/** 一个分区的容器。模块的列表项 portal 进这里，标题与间距由外壳掌握。 */
function SidebarSectionSlot({ id, title }: { id: SidebarSectionId; title: string }) {
  const ref = useSidebarContainerRef(id);
  return (
    <section className="mb-3">
      <h2 className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-[var(--text-faint)]">
        {title}
      </h2>
      <div ref={ref} />
    </section>
  );
}

export function Sidebar({
  activeId,
  onNavigate,
  user,
  onOpenAccount,
  onOpenSettings,
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
          className="rounded-[10px] p-2 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
        >
          <PanelLeftClose className="h-4 w-4 rotate-180" />
        </button>
        <div className="mt-auto">
          <Avatar name={user?.username ?? null} size={26} />
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
          className="shrink-0 rounded-[10px] p-2 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {sections.map((section) => (
          <SidebarSectionSlot key={section.id} id={section.id} title={section.title} />
        ))}
        {sections.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--text-faint)]">
            这里会显示置顶、对话与房间
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--surface-border)] p-2">
        <AccountButton
          user={user}
          onOpenAccount={onOpenAccount}
          onOpenSettings={onOpenSettings}
          onNavigate={onNavigate}
        />
      </div>
    </aside>
  );
}
