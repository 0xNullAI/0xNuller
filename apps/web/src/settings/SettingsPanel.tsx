import { lazy, Suspense, useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Cpu,
  AudioWaveform,
  Database,
  Info,
  LayoutTemplate,
  Bell,
  SlidersHorizontal,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import {
  ModuleSettingsSlot,
  SettingsSubpageProvider,
  useModuleSettingsClaims,
  type SettingsSubpage,
} from '@0xnullai/ui';
import { avatarSrc, type AuthUser } from '@0xnullai/auth';
import { Avatar } from '@0xnullai/ui';
import { GeneralTab } from './GeneralTab';
import { AiTab, type AiSettingsSection } from './AiTab';
import { SafetyTab } from './SafetyTab';
import { ScenesTab } from './ScenesTab';
import { AccountContent } from './AccountContent';
import { AdminContent } from './AdminContent';
import { AboutTab } from './AboutTab';
import { NotificationsTab } from './NotificationsTab';

const PersonalMemoryContent = lazy(() =>
  import('./PersonalMemoryContent').then((module) => ({ default: module.PersonalMemoryContent })),
);

/** One grouped settings list with second-level pages; modules supply page contents. */

const DEFERRED_TABS = [
  { id: 'agent-waveforms', label: '波形', icon: AudioWaveform, order: 30 },
  { id: 'agent-data', label: '数据', icon: Database, order: 60 },
];

const TABS = [
  { id: 'account', label: '账户', icon: UserRound, Component: null, order: 0 },
  { id: 'appearance', label: '通用', icon: SlidersHorizontal, Component: GeneralTab, order: 10 },
  { id: 'memory', label: '个人记忆', icon: Database, Component: null, order: 15 },
  { id: 'notifications', label: '通知', icon: Bell, Component: null, order: 16 },
  { id: 'ai', label: 'AI', icon: Cpu, Component: AiTab, order: 20 },
  { id: 'scenes', label: '场景', icon: LayoutTemplate, Component: ScenesTab, order: 40 },
  { id: 'safety', label: '设备安全', icon: ShieldAlert, Component: SafetyTab, order: 50 },
  { id: 'about', label: '关于', icon: Info, Component: AboutTab, order: 90 },
  { id: 'admin', label: '管理', icon: ShieldCheck, Component: AdminContent, order: 100 },
] as const;

export function SettingsPanel({
  initialTab = 'overview',
  initialMemoryChat,
  onNavigateTab,
  user,
  onUser,
  onClose,
  onLoadAgent,
}: {
  /** Which page to land on when opened. AI entry points may target one module subsection. */
  initialTab?: string;
  initialMemoryChat?: { kind: 'dm' | 'group'; id: string };
  onNavigateTab: (tab: string) => void;
  user: AuthUser | null;
  onUser: (user: AuthUser | null) => void;
  onClose: () => void;
  onLoadAgent?: () => void;
}) {
  const initialAiSection: AiSettingsSection =
    initialTab === 'ai-video' ? 'video' : initialTab === 'ai-voice' ? 'voice' : 'agent';
  const tab = initialTab.startsWith('ai-') ? 'ai' : initialTab;
  // Pages declared by whichever modules are mounted. They are settings like
  // any other and belong in this panel, but they read module state the shell
  // does not have, so the module declares the page and the shell places it.
  const moduleClaims = useModuleSettingsClaims();
  const [subpage, setSubpage] = useState<SettingsSubpage | null>(null);
  const builtinTabs = user?.role === 'admin' ? TABS : TABS.filter((item) => item.id !== 'admin');
  const navigationTabs = [
    ...builtinTabs.map((item) => ({
      id: item.id as string,
      label: item.label,
      icon: item.icon,
      order: item.order,
    })),
    ...DEFERRED_TABS.filter((item) => !moduleClaims.some((claim) => claim.id === item.id)),
    ...moduleClaims,
  ].sort((left, right) => left.order - right.order);
  const activeEntry = navigationTabs.find((item) => item.id === tab);
  const resolvedTab = tab === 'overview' || activeEntry ? tab : 'overview';
  const Active = builtinTabs.find((t) => t.id === resolvedTab)?.Component;
  const groups = [
    {
      title: '聊天与角色',
      items: navigationTabs.filter((item) => item.order >= 10 && item.order < 50),
    },
    {
      title: '安全与数据',
      items: navigationTabs.filter((item) => item.order >= 50 && item.order < 90),
    },
    { title: '更多', items: navigationTabs.filter((item) => item.order >= 90) },
  ].filter((group) => group.items.length > 0);
  useEffect(() => {
    if (tab.startsWith('agent-') || tab === 'safety') onLoadAgent?.();
  }, [tab, onLoadAgent]);

  return (
    <SettingsSubpageProvider onChange={setSubpage}>
      <section
        aria-label="设置"
        className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col bg-[var(--bg)] [--settings-surface:var(--bg)]"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--surface-border)] px-4 py-3">
          <button
            type="button"
            onClick={() =>
              subpage
                ? subpage.onBack()
                : resolvedTab === 'overview'
                  ? onClose()
                  : onNavigateTab('overview')
            }
            aria-label={
              subpage ? '返回上一页' : resolvedTab === 'overview' ? '关闭设置' : '返回设置列表'
            }
            // On a phone 我的 is a top-level tab, so its list page has nothing to close.
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-[var(--bg-soft)] ${resolvedTab === 'overview' && !subpage ? 'max-md:hidden' : ''}`}
          >
            {resolvedTab === 'overview' && !subpage ? (
              <X className="h-5 w-5" />
            ) : (
              <ChevronLeft className="h-5 w-5" />
            )}
          </button>
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
            {subpage?.title ??
              (resolvedTab === 'overview' ? '我的' : (activeEntry?.label ?? '我的'))}
          </h2>
        </header>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-8 pt-5 sm:px-5">
          {resolvedTab === 'overview' ? (
            <div className="grid gap-5 md:grid-cols-2 md:items-start">
              <button
                type="button"
                onClick={() => onNavigateTab('account')}
                className="flex w-full items-center gap-3 rounded-2xl bg-[var(--bg-elevated)] p-4 text-left hover:bg-[var(--bg-soft)] md:col-span-2"
              >
                <Avatar
                  name={user?.displayName ?? null}
                  username={user?.username}
                  src={avatarSrc(user?.avatarUrl)}
                  size={44}
                />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-base">
                    {user?.displayName ?? '登录 / 注册'}
                  </strong>
                  <span className="block text-xs text-[var(--text-soft)]">
                    {user ? '账户与 Credit' : '登录后同步聊天和个人内容'}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 text-[var(--text-faint)]" />
              </button>
              {groups.map((group) => (
                <div key={group.title}>
                  <h3 className="px-3 pb-2 text-xs font-medium text-[var(--text-soft)]">
                    {group.title}
                  </h3>
                  <div className="overflow-hidden rounded-2xl bg-[var(--bg-elevated)]">
                    {group.items.map((item, index) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => onNavigateTab(item.id)}
                          className={`flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm hover:bg-[var(--bg-soft)] ${index > 0 ? 'border-t border-[var(--surface-border)]' : ''}`}
                        >
                          {Icon ? <Icon className="h-5 w-5 shrink-0 text-[var(--accent)]" /> : null}
                          <span className="min-w-0 flex-1">{item.label}</span>
                          <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {resolvedTab === 'account' ? (
                <AccountContent user={user} onUser={onUser} onDone={onClose} />
              ) : resolvedTab === 'memory' && user ? (
                <Suspense fallback={<p role="status">正在读取个人记忆…</p>}>
                  <PersonalMemoryContent key={user.id} initialChat={initialMemoryChat} />
                </Suspense>
              ) : resolvedTab === 'notifications' ? (
                <NotificationsTab key={user?.id ?? 'signed-out'} accountId={user?.id ?? null} />
              ) : resolvedTab === 'ai' ? (
                <AiTab key={initialAiSection} initialSection={initialAiSection} />
              ) : Active ? (
                <Active />
              ) : null}
              {resolvedTab.startsWith('agent-') &&
                !moduleClaims.some((claim) => claim.id === resolvedTab) && (
                  <p role="status">正在加载设置内容…</p>
                )}
              {moduleClaims
                .filter((claim) => claim.id === resolvedTab)
                .map((claim) => (
                  <div key={claim.id}>
                    <ModuleSettingsSlot id={claim.id} />
                  </div>
                ))}
            </>
          )}
        </div>
      </section>
    </SettingsSubpageProvider>
  );
}
