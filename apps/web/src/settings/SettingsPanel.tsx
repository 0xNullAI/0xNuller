import { lazy, Suspense, useEffect } from 'react';
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
  Settings2,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import {
  ModuleSettingsSlot,
  useModuleSettingsClaims,
  useSettingsSubpageHeader,
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
import { AdvancedSettingsPage } from './AdvancedSettingsPage';
import { SettingsGroup, SettingsRow } from './settings-list';

const PersonalMemoryContent = lazy(() =>
  import('./PersonalMemoryContent').then((module) => ({ default: module.PersonalMemoryContent })),
);

/**
 * One settings list with second-level pages; modules supply page contents. The overview
 * keeps only the pages most people need; the rest sit behind one 高级设置 row. Every page
 * keeps its own /settings/<id> route, so deep links and browser history still work.
 */

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
  { id: 'scenes', label: '角色与场景', icon: LayoutTemplate, Component: ScenesTab, order: 40 },
  { id: 'safety', label: '设备安全', icon: ShieldAlert, Component: SafetyTab, order: 50 },
  { id: 'about', label: '关于', icon: Info, Component: AboutTab, order: 90 },
  { id: 'admin', label: '管理', icon: ShieldCheck, Component: AdminContent, order: 100 },
  { id: 'advanced', label: '高级设置', icon: Settings2, Component: null, order: 200 },
] as const;

/** Pages listed on the 高级设置 page instead of the overview. */
/** Settings of the open conversation: reached from its header only, never listed under 我的. */
const CONVERSATION_PAGE_IDS: ReadonlySet<string> = new Set(['agent-companion']);
const ADVANCED_PAGE_IDS: ReadonlySet<string> = new Set([
  'memory',
  'scenes',
  'agent-waveforms',
  'agent-data',
  'admin',
]);

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
  const initialAiSection: AiSettingsSection | undefined =
    initialTab === 'ai-video' ? 'video' : initialTab === 'ai-voice' ? 'voice' : undefined;
  const tab = initialTab.startsWith('ai-') ? 'ai' : initialTab;
  // Pages declared by whichever modules are mounted. They are settings like
  // any other and belong in this panel, but they read module state the shell
  // does not have, so the module declares the page and the shell places it.
  const moduleClaims = useModuleSettingsClaims();
  const subpage = useSettingsSubpageHeader();
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
  const overviewItems = navigationTabs.filter(
    (item) =>
      item.id !== 'account' &&
      item.id !== 'advanced' &&
      !ADVANCED_PAGE_IDS.has(item.id) &&
      !CONVERSATION_PAGE_IDS.has(item.id),
  );
  const advancedItems = navigationTabs.filter((item) => ADVANCED_PAGE_IDS.has(item.id));
  const advancedEntry = navigationTabs.find((item) => item.id === 'advanced');
  const parentTab = ADVANCED_PAGE_IDS.has(resolvedTab) ? 'advanced' : 'overview';
  useEffect(() => {
    if (tab.startsWith('agent-') || tab === 'safety') onLoadAgent?.();
  }, [tab, onLoadAgent]);

  return (
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
              : resolvedTab === 'overview' || CONVERSATION_PAGE_IDS.has(resolvedTab)
                ? onClose()
                : onNavigateTab(parentTab)
          }
          aria-label={
            subpage
              ? '返回上一页'
              : resolvedTab === 'overview'
                ? '关闭设置'
                : CONVERSATION_PAGE_IDS.has(resolvedTab)
                  ? '返回聊天'
                  : parentTab === 'advanced'
                    ? '返回高级设置'
                    : '返回设置列表'
          }
          // On a phone 我的 is a top-level tab, so its list page has nothing to close.
          className={`ui-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-[var(--bg-soft)] ${resolvedTab === 'overview' && !subpage ? 'max-md:hidden' : ''}`}
        >
          {resolvedTab === 'overview' && !subpage ? (
            <X className="h-5 w-5" />
          ) : (
            <ChevronLeft className="h-5 w-5" />
          )}
        </button>
        <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold md:text-lg">
          {subpage?.title ?? (resolvedTab === 'overview' ? '我的' : (activeEntry?.label ?? '我的'))}
        </h2>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-8 pt-5 sm:px-5">
        {/* Keyed on the page so each page arrives once: the list fades, a sub-page pushes in. */}
        <div
          key={resolvedTab}
          className={resolvedTab === 'overview' ? 'ui-tab-fade' : 'ui-push-in'}
        >
          {resolvedTab === 'overview' ? (
            <div className="flex flex-col gap-6">
              <button
                type="button"
                onClick={() => onNavigateTab('account')}
                className="flex w-full items-center gap-3 rounded-2xl bg-[var(--bg-elevated)] p-4 text-left transition-colors duration-150 hover:bg-[var(--bg-soft)] active:bg-[var(--bg-soft)] motion-reduce:transition-none"
              >
                <Avatar
                  name={user?.displayName ?? null}
                  username={user?.username}
                  src={avatarSrc(user?.avatarUrl)}
                  size={52}
                />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-[17px] font-semibold">
                    {user?.displayName ?? '登录 / 注册'}
                  </strong>
                  <span className="block truncate text-[13px] text-[var(--text-faint)]">
                    {user ? `@${user.username}` : '登录后同步聊天和个人内容'}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 text-[var(--text-faint)]" aria-hidden />
              </button>
              <SettingsGroup>
                {overviewItems
                  .filter((item) => item.id !== 'about')
                  .map((item) => (
                    <SettingsRow
                      key={item.id}
                      icon={item.icon}
                      label={item.label}
                      onClick={() => onNavigateTab(item.id)}
                    />
                  ))}
              </SettingsGroup>
              <SettingsGroup>
                {[
                  ...overviewItems.filter((item) => item.id === 'about'),
                  ...(advancedEntry ? [advancedEntry] : []),
                ].map((item) => (
                  <SettingsRow
                    key={item.id}
                    icon={item.icon}
                    label={item.label}
                    onClick={() => onNavigateTab(item.id)}
                  />
                ))}
              </SettingsGroup>
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
              ) : resolvedTab === 'advanced' ? (
                <AdvancedSettingsPage entries={advancedItems} onNavigate={onNavigateTab} />
              ) : resolvedTab === 'ai' ? (
                <AiTab key={initialAiSection ?? 'main'} initialSection={initialAiSection} />
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
      </div>
    </section>
  );
}
