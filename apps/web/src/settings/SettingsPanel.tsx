import { lazy, Suspense, useEffect, useState } from 'react';
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  Drama,
  Info,
  Settings2,
  Sparkles,
  UserRound,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import {
  ModuleSettingsSlot,
  useModuleSettingsClaims,
  useSettingsSubpageHeader,
} from '@0xnullai/ui';
import { avatarSrc, type AuthUser } from '@0xnullai/auth';
import { useCreditBalance } from '../credit-balance';
import { Avatar, useTheme } from '@0xnullai/ui';
import { loadLlmConfig } from '@0xnullai/llm-providers';
import { loadScenes, subscribeScenes } from '@0xnullai/scenes';
import { PRODUCT_VERSION } from '../product';
import { GeneralTab } from './GeneralTab';
import { AiTab, type AiSettingsSection } from './AiTab';
import { SafetyTab } from './SafetyTab';
import { ScenesTab } from './ScenesTab';
import { AccountContent } from './AccountContent';
import { AdminContent } from './AdminContent';
import { AboutTab } from './AboutTab';
import { SettingsGroup, SettingsRow } from './settings-list';

const PersonalMemoryContent = lazy(() =>
  import('./PersonalMemoryContent').then((module) => ({ default: module.PersonalMemoryContent })),
);

/**
 * One settings list with second-level pages; modules supply page contents. The overview
 * keeps only the pages most people need; the rest sit behind one 高级设置 row. Every page
 * keeps its own /settings/<id> route, so deep links and browser history still work.
 */

const TABS = [
  { id: 'account', label: '账户', icon: UserRound, Component: null, order: 0 },
  { id: 'scenes', label: '角色与场景', icon: Drama, Component: ScenesTab, order: 10 },
  { id: 'memory', label: '个人记忆', icon: Brain, Component: null, order: 15 },
  { id: 'ai', label: 'AI', icon: Sparkles, Component: AiTab, order: 20 },
  { id: 'safety', label: '设备与安全', icon: Zap, Component: null, order: 50 },
  { id: 'appearance', label: '通用', icon: Settings2, Component: null, order: 80 },
  { id: 'about', label: '关于', icon: Info, Component: null, order: 90 },
  { id: 'admin', label: '管理', icon: Wrench, Component: AdminContent, order: 100 },
] as const;

/** Pages opened from inside another page; their back arrow returns there. */
const PARENT_PAGES: Readonly<Record<string, string>> = { memory: 'ai' };

const OVERVIEW_GROUPS = [
  { label: '', ids: ['appearance', 'safety'] },
  { label: '陪伴', ids: ['scenes', 'ai'] },
  { label: '其他', ids: ['about', 'admin'] },
] as const satisfies readonly { label: string; ids: readonly string[] }[];

const THEME_LABELS = { auto: '跟随系统', dark: '深色', light: '浅色' } as const;

/** The current value each overview row shows, read from local state only (no requests). */
function useOverviewValues(active: boolean): Record<string, string> {
  const { mode } = useTheme();
  const [sceneCount, setSceneCount] = useState(() => loadScenes().scenes.length);
  useEffect(
    () => (active ? subscribeScenes((library) => setSceneCount(library.scenes.length)) : undefined),
    [active],
  );
  const managed = loadLlmConfig().providerId === 'managed';
  return {
    scenes: sceneCount ? `${sceneCount} 个` : '',
    ai: managed ? '猫愿模型' : '自己的 API',
    appearance: THEME_LABELS[mode as keyof typeof THEME_LABELS] ?? '',
    about: `v${PRODUCT_VERSION}`,
  };
}

/** Settings of the open conversation: reached from its header only, never listed under 我的. */
const CONVERSATION_PAGE_IDS: ReadonlySet<string> = new Set(['agent-companion']);
/** Module pages shown inside a built-in page instead of as their own entry. */
const EMBEDDED_PAGE_IDS: ReadonlySet<string> = new Set(['agent-waveforms', 'agent-data']);

export function SettingsPanel({
  initialTab = 'overview',
  onNavigateTab,
  user,
  onUser,
  onClose,
  onLoadAgent,
  onOpenAgent,
}: {
  /** Which page to land on when opened. AI entry points may target one module subsection. */
  initialTab?: string;
  onNavigateTab: (tab: string) => void;
  user: AuthUser | null;
  onUser: (user: AuthUser | null) => void;
  onClose: () => void;
  onLoadAgent?: () => void;
  /** Leave settings for the Agent chat after a chat was opened from the library. */
  onOpenAgent?: () => void;
}) {
  const initialAiSection: AiSettingsSection | undefined =
    initialTab === 'ai-video' ? 'video' : undefined;
  // 通知 now lives inside 通用; older links to /settings/notifications land there.
  const tab = initialTab.startsWith('ai-')
    ? 'ai'
    : initialTab === 'notifications'
      ? 'appearance'
      : // 波形 lives inside 设备, 数据 inside 关于, and 高级设置 is gone.
        initialTab === 'agent-waveforms'
        ? 'safety'
        : initialTab === 'agent-data'
          ? 'about'
          : initialTab === 'advanced'
            ? 'overview'
            : initialTab;
  // Pages declared by whichever modules are mounted. They are settings like
  // any other and belong in this panel, but they read module state the shell
  // does not have, so the module declares the page and the shell places it.
  const moduleClaims = useModuleSettingsClaims();
  const subpage = useSettingsSubpageHeader();
  const overviewValues = useOverviewValues(tab === 'overview');
  const credit = useCreditBalance(user?.id ?? null)?.available ?? null;
  const builtinTabs = user?.role === 'admin' ? TABS : TABS.filter((item) => item.id !== 'admin');
  const navigationTabs = [
    ...builtinTabs.map((item) => ({
      id: item.id as string,
      label: item.label,
      icon: item.icon,
      order: item.order,
    })),
    ...moduleClaims.filter((claim) => !EMBEDDED_PAGE_IDS.has(claim.id)),
  ].sort((left, right) => left.order - right.order);
  const activeEntry = navigationTabs.find((item) => item.id === tab);
  const resolvedTab = tab === 'overview' || activeEntry ? tab : 'overview';
  const Active = builtinTabs.find((t) => t.id === resolvedTab)?.Component;
  const overviewItems = navigationTabs.filter(
    (item) => item.id !== 'account' && !CONVERSATION_PAGE_IDS.has(item.id),
  );
  useEffect(() => {
    // 设备 embeds the waveform library and 关于 the data page; both come from Agent.
    if (tab.startsWith('agent-') || tab === 'safety' || tab === 'about') onLoadAgent?.();
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
                : onNavigateTab(PARENT_PAGES[resolvedTab] ?? 'overview')
          }
          aria-label={
            subpage
              ? '返回上一页'
              : resolvedTab === 'overview'
                ? '关闭设置'
                : CONVERSATION_PAGE_IDS.has(resolvedTab)
                  ? '返回聊天'
                  : PARENT_PAGES[resolvedTab]
                    ? '返回上一页'
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
                {user && credit !== null ? (
                  <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-[var(--text-soft)]">
                    {credit} Credit
                  </span>
                ) : null}
                <ChevronRight className="h-4 w-4 text-[var(--text-faint)]" aria-hidden />
              </button>
              {OVERVIEW_GROUPS.map((group) => {
                const ids: readonly string[] = group.ids;
                // The group's own order, not the pages' sort order.
                const rows = ids.flatMap((id) => overviewItems.filter((item) => item.id === id));
                if (rows.length === 0) return null;
                return (
                  <SettingsGroup key={group.ids[0]} label={group.label || undefined}>
                    {rows.map((item) => (
                      <SettingsRow
                        key={item.id}
                        icon={item.icon}
                        label={item.label}
                        value={overviewValues[item.id]}
                        onClick={() => onNavigateTab(item.id)}
                      />
                    ))}
                  </SettingsGroup>
                );
              })}
            </div>
          ) : (
            <>
              {resolvedTab === 'account' ? (
                <AccountContent user={user} onUser={onUser} onDone={onClose} />
              ) : resolvedTab === 'memory' && user ? (
                <Suspense fallback={<p role="status">正在读取个人记忆…</p>}>
                  <PersonalMemoryContent key={user.id} />
                </Suspense>
              ) : resolvedTab === 'safety' ? (
                <SafetyTab
                  waveforms={
                    moduleClaims.some((claim) => claim.id === 'agent-waveforms') ? (
                      <ModuleSettingsSlot id="agent-waveforms" />
                    ) : (
                      <p role="status">正在加载波形…</p>
                    )
                  }
                />
              ) : resolvedTab === 'appearance' ? (
                <GeneralTab key={user?.id ?? 'signed-out'} accountId={user?.id ?? null} />
              ) : resolvedTab === 'about' ? (
                <AboutTab
                  data={
                    moduleClaims.some((claim) => claim.id === 'agent-data') ? (
                      <ModuleSettingsSlot id="agent-data" />
                    ) : (
                      <p role="status">正在加载数据…</p>
                    )
                  }
                />
              ) : resolvedTab === 'ai' ? (
                <AiTab
                  key={initialAiSection ?? 'main'}
                  initialSection={initialAiSection}
                  onOpenMemory={user ? () => onNavigateTab('memory') : undefined}
                />
              ) : resolvedTab === 'scenes' ? (
                <ScenesTab onOpenAgent={onOpenAgent} />
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
