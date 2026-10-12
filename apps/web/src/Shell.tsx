import { allowGuardedNavigation, installHistoryNavigationGuard } from '@0xnullai/ui';
import { PersistenceNotice } from './PersistenceNotice';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import {
  useTheme,
  subscribeMediaQuery,
  ShellChromeProvider,
  type ShellSettingsTab,
  ModuleActionsProvider,
  useModuleActionsContainer,
  SidebarSectionsProvider,
  ModuleSettingsProvider,
  OverlayProvider,
  StopFailureBanner,
  useOverlayRoot,
  useModuleOverlayLayer,
  ShellNavProvider,
} from '@0xnullai/ui';
import {
  me,
  getCreditBalance,
  subscribeAuthChanges,
  subscribeProfileChanges,
  subscribeProfileRequests,
  type AuthUser,
} from '@0xnullai/auth';
import { MODULES, moduleIdFromPath } from './routes';
import { pageAliasFromPath } from './page-aliases';
import { isLegalTermsPath } from './legal/legal-routes';
import { useUnreadMessages } from './unread-messages';
import { InboxColumn, MobileTabBar, NavRail, type MobileTab } from './Sidebar';
import { UnifiedInbox } from './UnifiedInbox';
import { DeviceBar } from './DeviceBar';
import { shouldShowDeviceBarConnect } from './device-bar-connect';
const ContactsDialog = lazy(() =>
  import('./ContactsDialog').then((module) => ({ default: module.ContactsDialog })),
);
const ProfileDialog = lazy(() =>
  import('./profile/ProfileDialog').then((module) => ({ default: module.ProfileDialog })),
);
const SettingsPanel = lazy(() =>
  import('./settings/SettingsPanel').then((module) => ({ default: module.SettingsPanel })),
);
const AccountContent = lazy(() =>
  import('./settings/AccountContent').then((module) => ({ default: module.AccountContent })),
);
const LegalPage = lazy(() =>
  import('./legal/LegalPage').then((module) => ({ default: module.LegalPage })),
);
import { ModuleErrorBoundary } from './ModuleErrorBoundary';
import { grantDeviceLease } from '@dg-kit/safety';

/**
 * Desktop uses one navigation column, with the conversation list below the
 * primary destinations while chatting. Mobile keeps its message-first tabs.
 *
 * The previous shell failed in three places, all of them now solved at the
 * contract level:
 * 1. **Tailwind's scan root got displaced** — shell.css declares an explicit
 *    @source per module. Adding a new module means adding a line there; miss it
 *    and that module's utility classes are silently tree-shaken while the build
 *    stays green.
 * 2. **Overlay escape** — the overlay container is mounted as a sibling of the
 *    shell root, and every module dialog portals into it.
 * 3. **Module roots hard-coding 100dvh** — module roots are always h-full.
 *
 * A module **stays mounted once it has been opened**; switching away only hides
 * it — the BLE connection and the module state both stay alive. That is the one
 * irreplaceable benefit of putting them in the same origin.
 */

interface RouteState {
  pathname: string;
  opened: string[];
}

function nextState(prev: RouteState, pathname: string): RouteState {
  // The narrow root is the inbox, so do not boot the Agent runtime until an AI
  // conversation is actually opened. Desktop root still opens the chat pane.
  const mobileInbox =
    pathname === '/' &&
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 767px)').matches;
  const id = mobileInbox ? null : moduleIdFromPath(pathname);
  const opened = id && !prev.opened.includes(id) ? [...prev.opened, id] : prev.opened;
  return { pathname, opened };
}

/** The route and the set of opened modules live in one piece of state and are
 *  updated in the same transition — a ref would mean writing a ref during render
 *  (unsafe under concurrent rendering), and keeping it in separate state written
 *  back from an effect would cost an extra cascading render. */
function useHistoryRoute(): [RouteState, (path: string) => boolean, (moduleId: string) => void] {
  const [state, setState] = useState<RouteState>(() =>
    nextState(
      { pathname: '/', opened: [] },
      typeof window === 'undefined' ? '/' : window.location.pathname,
    ),
  );

  useEffect(() => {
    const uninstallGuard = installHistoryNavigationGuard();
    const sync = () => setState((prev) => nextState(prev, window.location.pathname));
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      uninstallGuard();
    };
  }, []);

  const navigate = useCallback((path: string) => {
    const target = new URL(path, window.location.href);
    if (
      `${window.location.pathname}${window.location.search}` ===
      `${target.pathname}${target.search}`
    )
      return true;
    if (!allowGuardedNavigation(target)) return false;
    window.history.pushState(null, '', path);
    setState((prev) => nextState(prev, target.pathname));
    return true;
  }, []);

  const ensureModuleOpened = useCallback((moduleId: string) => {
    setState((prev) =>
      prev.opened.includes(moduleId) ? prev : { ...prev, opened: [...prev.opened, moduleId] },
    );
  }, []);

  return [state, navigate, ensureModuleOpened];
}

const MOBILE_TAB_PATHS: Record<Exclude<MobileTab, 'me'>, string> = {
  messages: '/',
  people: '/people',
  discover: '/market',
  device: '/control',
};

/** Below this width the sidebar gives way to the mobile chat layout. */
const NARROW_QUERY = '(max-width: 767px)';

function settingsPageFromRoute(pathname: string, search: string): string | null {
  if (pathname === '/settings') return 'account'; // Existing verification and referral links.
  if (pathname.startsWith('/settings/')) {
    const page = pathname.slice('/settings/'.length);
    return /^[a-z][a-z0-9-]*$/.test(page) ? page : 'overview';
  }
  const params = new URLSearchParams(search);
  return params.has('verify') || params.has('reset') ? 'account' : null;
}

function profileUsernameFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/u/')) return null;
  try {
    const username = decodeURIComponent(pathname.slice('/u/'.length)).trim();
    // A malformed shared link must not crash the entire signed-in shell or
    // turn an encoded separator into another route.
    return username && !username.includes('/') && !username.includes('\\') ? username : null;
  } catch {
    return null;
  }
}

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    return subscribeMediaQuery(mq, on);
  }, []);

  return narrow;
}

export function Shell() {
  const [{ pathname, opened }, navigate, ensureModuleOpened] = useHistoryRoute();
  const activeId = moduleIdFromPath(pathname);
  const profileRoute = profileUsernameFromPath(pathname);
  const peopleRoute = pathname === '/people';
  // A screen pushed inside 联系人 (/people?view=…) draws its own back arrow and title.
  const peopleSubview = peopleRoute && new URLSearchParams(window.location.search).has('view');
  const pageLabel = peopleRoute ? '联系人' : profileRoute ? '个人主页' : null;
  const activeLabel =
    activeId === 'control'
      ? '设备'
      : activeId === 'market'
        ? '发现'
        : activeId === 'playground'
          ? '游戏'
          : MODULES.find((m) => m.id === activeId)?.label;
  const overlayRoot = useOverlayRoot();
  const narrow = useIsNarrow();
  const mobileInbox = narrow && pathname === '/';
  useEffect(() => {
    // The root route starts as an inbox on a phone. If the viewport widens while
    // it is open, mount the desktop conversation instead of leaving an empty pane.
    if (!narrow && pathname === '/') ensureModuleOpened('agent');
  }, [ensureModuleOpened, narrow, pathname]);
  const conversationDetail =
    narrow && (activeId === 'agent' || activeId === 'chat') && !mobileInbox;
  // The theme is held solely by the shared store in @0xnullai/ui — the shell and the
  // modules see the same value.
  useTheme();

  const [user, setUser] = useState<AuthUser | null>(null);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const settingsTab = settingsPageFromRoute(pathname, window.location.search);
  const [settingsReturnPath, setSettingsReturnPath] = useState<string | null>(null);
  const authenticated = authChecked && user !== null;
  const visibleModuleId = !authenticated || mobileInbox || settingsTab ? null : activeId;
  const leaseModuleId = visibleModuleId;
  const showDesktopInbox =
    authenticated && !narrow && !settingsTab && (activeId === 'agent' || activeId === 'chat');

  const [actionsRef, actionsContainer] = useModuleActionsContainer();

  // Device control follows the active module. A module that is switched away from
  // loses control immediately — commands from other people in the room and commands
  // from a background AI are hard-rejected, not merely hidden behind a button the UI
  // no longer shows.
  //
  // **Handing over control is not the same as disconnecting the device**: the device
  // bar and the stop button are displayed as usual, there is just no module allowed
  // to issue commands.
  useEffect(() => {
    void grantDeviceLease(leaseModuleId);
  }, [leaseModuleId]);

  const loadAuth = useCallback(() => {
    // Every product route now shares one entry gate. Keep the original URL so
    // sign-in returns the user to the page they opened. Only a definite "no session"
    // answer shows sign-in; a network or service error is not a sign-out.
    void me()
      .then((current) => {
        setUser(current);
        setAuthChecked(true);
      })
      .catch(() => setAuthUnavailable(true));
  }, []);

  useEffect(loadAuth, [loadAuth]);

  // Old or guessed addresses (/contacts) go to the real page instead of an untitled inbox.
  // Only after sign-in: the sign-in screen keeps the original URL to return to.
  useEffect(() => {
    const alias = authenticated ? pageAliasFromPath(pathname) : null;
    if (!alias) return;
    window.history.replaceState(null, '', alias);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [authenticated, pathname]);
  const unreadMessages = useUnreadMessages(authChecked ? user : null);

  const retryAuth = () => {
    setAuthUnavailable(false);
    loadAuth();
  };

  useEffect(
    () =>
      subscribeProfileChanges(() => {
        // Keep the signed-in shell (and every mounted module) on a transient failure.
        void me()
          .then(setUser)
          .catch(() => undefined);
      }),
    [],
  );

  // An expired or revoked session (a 401 on any account request) signs this tab out.
  useEffect(
    () =>
      subscribeAuthChanges((current) => {
        if (!current) setUser(null);
      }),
    [],
  );

  useEffect(() => {
    if (!user) return;
    const refresh = () =>
      void getCreditBalance()
        .then((balance) => setCreditBalance(balance.available))
        .catch(() => setCreditBalance(null));
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [user]);

  // Modules ask for a profile rather than rendering one; see profile-requests
  // in @0xnullai/auth. Subscribing here rather than inside a module is what
  // keeps a lazily-mounted module from needing a provider threaded into it.
  useEffect(
    () =>
      subscribeProfileRequests((username) => {
        navigate(`/u/${encodeURIComponent(username)}`);
      }),
    [navigate],
  );

  // Where a module's UI needs a settings entry point (the Chat host's button for
  // configuring the AI), it opens **this** panel instead of the module standing up
  // one of its own. What a module gets is the position of the entry point, not a
  // second settings UI.
  const openSettings = useCallback(
    (tab: ShellSettingsTab = 'appearance') => {
      const origin = `${window.location.pathname}${window.location.search}`;
      if (navigate(`/settings/${tab}`) && !origin.startsWith('/settings')) {
        setSettingsReturnPath(origin);
      }
    },
    [navigate],
  );

  const closeSettings = useCallback(() => {
    const destination = settingsReturnPath ?? '/';
    if (navigate(destination)) setSettingsReturnPath(null);
  }, [navigate, settingsReturnPath]);

  const closeProfile = useCallback(() => {
    if (window.location.pathname.startsWith('/u/')) navigate('/people');
  }, [navigate]);

  const navigateFromShell = useCallback(
    (path: string) => {
      navigate(path);
    },
    [navigate],
  );

  const go = useCallback(
    (moduleId: string | null) => {
      navigateFromShell(moduleId ? `/${moduleId}` : '/');
    },
    [navigateFromShell],
  );

  // Modules read this to offer cross-module actions (start a chat from Market, voice or
  // camera from a conversation, back to text from Voice/Video). Without it every such
  // entry stays hidden inside the shell.
  const shellNav = useMemo(
    () => ({
      activeId,
      modules: MODULES.map(({ id, label, blurb }) => ({ id, label, blurb })),
      navigate: go,
      ...(conversationDetail ? { conversationBack: () => navigate('/') } : {}),
    }),
    [activeId, conversationDetail, go, navigate],
  );

  // The legal texts are public: they render before (and regardless of) the account check, so
  // the sign-up form and outside links can open them without an account.
  if (isLegalTermsPath(pathname)) {
    // Same device bar and stop banner as the sign-in screen: no module holds the lease here,
    // but a connected device's state and stop stay one action away.
    return (
      <div className="flex min-h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
        <DeviceBar activeSessionId={null} showConnect={false} />
        <Suspense fallback={<PageLoading label="文档" />}>
          <LegalPage onNavigate={navigateFromShell} />
        </Suspense>
        <StopFailureBanner />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="flex min-h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
        <DeviceBar activeSessionId={null} showConnect={false} />
        <main aria-label="账户登录" className="flex flex-1 items-center justify-center px-4 py-10">
          <div className="w-full max-w-sm rounded-2xl border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow-panel)]">
            <div className="mb-6 text-lg font-semibold">猫愿</div>
            {authChecked ? (
              <Suspense fallback={<PageLoading label="账户" />}>
                <AccountContent user={null} onUser={setUser} onDone={() => undefined} />
              </Suspense>
            ) : authUnavailable ? (
              <div role="alert" className="space-y-3 text-sm text-[var(--text-soft)]">
                <p>账户服务暂时无法连接。</p>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--surface-border)] px-3 py-1.5 text-[var(--text)]"
                  onClick={retryAuth}
                >
                  重试
                </button>
              </div>
            ) : (
              <p role="status" className="text-sm text-[var(--text-soft)]">
                正在检查账户…
              </p>
            )}
          </div>
        </main>
        <StopFailureBanner />
      </div>
    );
  }

  const mobileTab: MobileTab | null =
    settingsTab !== null
      ? 'me'
      : mobileInbox
        ? 'messages'
        : peopleRoute
          ? 'people'
          : activeId === 'market' || activeId === 'playground'
            ? 'discover'
            : activeId === 'control'
              ? 'device'
              : null;

  const rail = (
    <NavRail
      activeId={activeId}
      peopleActive={peopleRoute}
      settingsActive={settingsTab !== null}
      onNavigate={go}
      user={user}
      creditBalance={user ? creditBalance : null}
      unreadMessages={unreadMessages}
      onOpenAccount={() => {
        openSettings('overview');
      }}
      onOpenContacts={() => {
        navigateFromShell('/people');
      }}
    />
  );

  return (
    <ModuleSettingsProvider>
      <ShellNavProvider value={shellNav}>
        <SidebarSectionsProvider>
          <div
            id="shl-root"
            data-narrow={narrow || undefined}
            data-inbox={showDesktopInbox || undefined}
            data-settings-open={settingsTab !== null || undefined}
            data-tabbar={(narrow && !conversationDetail) || undefined}
          >
            {/* Wide screens: a navigation rail, plus the conversation list only while a
            conversation is open. Narrow screens use the bottom tab bar instead. */}
            {!narrow && <div id="shl-rail">{rail}</div>}
            {showDesktopInbox && (
              <div id="shl-side">
                <InboxColumn
                  user={user}
                  onNavigate={go}
                  onOpenAccount={() => openSettings('overview')}
                  onCreateRoom={() => navigateFromShell('/chat?create=1')}
                  onCreateCharacter={() => navigateFromShell('/market?editor=new&kind=character')}
                />
              </div>
            )}

            <main
              id="shl-slot"
              aria-label={mobileInbox ? '消息' : (pageLabel ?? activeLabel ?? '消息')}
            >
              {/* Wide screens stack module actions above device state. Narrow screens use
              the same wrapper as one compact toolbar, while the device section keeps
              its own horizontal overflow for multiple connected devices. */}
              <div id="shl-topbar">
                <div id="shl-actions">
                  {/* In a conversation the module header carries the back arrow (see
                    ShellNav.conversationBack), so this row only remains for device state. */}
                  {/* Phone: the page title only. The account lives in the 我的 tab, so the
                    bar carries no avatar; page actions (at most two icons) project to the
                    right through ModuleActions. */}
                  {narrow && profileRoute && (
                    // A pushed screen: back arrow + title, and the profile drops its own row.
                    <button
                      type="button"
                      onClick={closeProfile}
                      aria-label="返回"
                      className="ui-press flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <ChevronLeft className="h-6 w-6" aria-hidden />
                    </button>
                  )}
                  {narrow && !conversationDetail && !peopleSubview && (
                    <h1 className="flex min-h-11 min-w-0 shrink items-center truncate px-2 text-[17px] font-semibold">
                      {mobileInbox ? '消息' : (pageLabel ?? activeLabel ?? '消息')}
                    </h1>
                  )}
                  <div className="min-w-0 flex-1" />
                  <div ref={actionsRef} className="flex shrink-0 items-center gap-1" />
                </div>

                {/* Connected devices (and their stop control) always show. See
                shouldShowDeviceBarConnect for when the connect shortcut shows. */}
                <DeviceBar
                  activeSessionId={leaseModuleId}
                  showConnect={shouldShowDeviceBarConnect({
                    narrow,
                    conversationDetail,
                    leaseModuleId,
                  })}
                />
              </div>

              <PersistenceNotice />
              <div id="shl-content">
                {/* Shell pages project their top-bar icons the same way modules do. */}
                <ModuleActionsProvider container={actionsContainer}>
                  {mobileInbox ||
                  (activeId === null && !peopleRoute && !profileRoute && !settingsTab) ? (
                    <div className="ui-tab-fade h-full min-h-0">
                      <UnifiedInbox
                        presentation="page"
                        user={user}
                        onNavigate={go}
                        onOpenAccount={() => openSettings('account')}
                        onCreateRoom={() => navigate('/chat?create=1')}
                        onCreateCharacter={() => navigate('/market?editor=new&kind=character')}
                      />
                    </div>
                  ) : null}
                  {peopleRoute ? (
                    <div className="ui-tab-fade h-full min-h-0">
                      <Suspense fallback={<PageLoading label="交友" />}>
                        <ContactsDialog
                          user={user}
                          presentation="page"
                          onClose={() => navigate('/')}
                        />
                      </Suspense>
                    </div>
                  ) : null}
                </ModuleActionsProvider>
                {profileRoute ? (
                  <Suspense fallback={<PageLoading label="个人主页" />}>
                    <ProfileDialog
                      username={profileRoute}
                      viewer={user}
                      presentation="page"
                      onOpenMarketItem={(id) => {
                        if (navigate(`/market?item=${encodeURIComponent(id)}`))
                          window.dispatchEvent(new PopStateEvent('popstate'));
                      }}
                      shellBack={narrow}
                      onClose={closeProfile}
                    />
                  </Suspense>
                ) : null}
                {opened.map((id) => {
                  const mod = MODULES.find((m) => m.id === id);
                  if (!mod) return null;
                  if (mod.id === 'chat' && !user.emailVerified) {
                    return (
                      <div
                        key={id}
                        hidden={id !== activeId}
                        className={id === activeId ? 'h-full min-h-0' : 'hidden'}
                      >
                        <EmailVerificationGate onOpenAccount={() => openSettings('account')} />
                      </div>
                    );
                  }
                  return (
                    <ModuleSlot
                      key={id}
                      mod={mod}
                      active={id === visibleModuleId}
                      motion={conversationDetail ? 'push' : 'fade'}
                      overlayRoot={overlayRoot}
                      // Only the visible module may fill the top bar; a hidden one (Agent
                      // under the phone inbox) must not leave its buttons there.
                      actionsContainer={id === visibleModuleId ? actionsContainer : null}
                      openSettings={openSettings}
                      signedIn={!!user}
                    />
                  );
                })}
              </div>
            </main>

            {settingsTab && (
              <aside id="shl-settings" aria-label="我的设置">
                <DeviceBar
                  activeSessionId={null}
                  showConnect={false}
                  elementId="shl-settings-device-bar"
                />
                <OverlayProvider container={overlayRoot}>
                  <ModuleErrorBoundary moduleId="settings" label="设置">
                    <Suspense
                      fallback={
                        <div role="status" className="p-5">
                          正在加载设置…
                        </div>
                      }
                    >
                      <SettingsPanel
                        initialTab={settingsTab}
                        onNavigateTab={(tab) => navigate(`/settings/${encodeURIComponent(tab)}`)}
                        onLoadAgent={() => ensureModuleOpened('agent')}
                        onOpenAgent={() => go('agent')}
                        user={user}
                        onUser={setUser}
                        onClose={closeSettings}
                      />
                    </Suspense>
                  </ModuleErrorBoundary>
                </OverlayProvider>
              </aside>
            )}

            {/* Outside the content column so the tabs stay on every top-level page,
            including 我的 (settings), which replaces the content column. */}
            {narrow && !conversationDetail && (
              <MobileTabBar
                current={mobileTab}
                unreadMessages={unreadMessages}
                onSelect={(tab) => {
                  if (tab === 'me') openSettings('overview');
                  else navigate(MOBILE_TAB_PATHS[tab]);
                }}
              />
            )}

            {/* Outside the overlay provider on purpose. The overlay container is
            per-module and gets hidden when you switch modules, but "a device
            did not stop" outlives whichever module was showing — and it has
            to stay reachable while a dialog is open, which is why it sits at
            the top of the z scale rather than in the overlay layer. */}
            <StopFailureBanner />
          </div>
        </SidebarSectionsProvider>
      </ShellNavProvider>
    </ModuleSettingsProvider>
  );
}

function PageLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--text-faint)]">
      正在加载{label}…
    </div>
  );
}

function EmailVerificationGate({ onOpenAccount }: { onOpenAccount: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-xl font-semibold">验证邮箱后使用聊天</h1>
        <button
          type="button"
          onClick={onOpenAccount}
          className="rounded-[var(--radius-ctl)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--button-text)]"
        >
          前往账户验证
        </button>
      </div>
    </div>
  );
}

/**
 * One module's slot.
 *
 * Overlays get a **separate sub-layer per module** that shows and hides along with
 * the module — once a dialog has portaled out of the module subtree, the hidden
 * attribute on the module container no longer reaches it. Observed symptom: open a
 * dialog in Chat, then switch to Market, and Chat's dialog still floats above
 * Market, squeezed into a narrow column.
 */
function ModuleSlot({
  mod,
  active,
  motion,
  overlayRoot,
  actionsContainer,
  openSettings,
  signedIn,
}: {
  mod: (typeof MODULES)[number];
  active: boolean;
  /** push: a conversation opened from the phone inbox slides in; fade: a tab switch. */
  motion: 'push' | 'fade';
  overlayRoot: HTMLElement | undefined;
  actionsContainer: HTMLElement | null;
  openSettings: (tab?: ShellSettingsTab) => void;
  signedIn: boolean;
}) {
  const layer = useModuleOverlayLayer(overlayRoot, mod.id, active);
  return (
    <ShellChromeProvider openSettings={openSettings} signedIn={signedIn} active={active}>
      <ModuleActionsProvider container={actionsContainer}>
        <OverlayProvider container={layer}>
          <div
            hidden={!active}
            // Modules that are not current stay in the DOM but invisible — both the
            // connection and the state are preserved.
            // Do not add a lasting transform/filter here: that flips the reference frame
            // for fixed-position elements inside the module that rely on the viewport as
            // their containing block. A tab switch animates opacity only; the phone push
            // holds a transform for its 280ms and then leaves none.
            // The motion classes run only while the slot appears, then leave no transform.
            className={
              active
                ? `h-full min-h-0 ${motion === 'push' ? 'ui-push-in' : 'ui-tab-fade'}`
                : 'hidden'
            }
            aria-hidden={!active}
          >
            {/* The boundary sits inside Suspense and outside the module: a throw
                during the module's render burns down only this one slot, and the
                shell (along with the stop button in the device bar) has to survive. */}
            <ModuleErrorBoundary moduleId={mod.id} label={mod.label}>
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-sm text-[var(--text-faint)]">
                    正在加载 {mod.label}…
                  </div>
                }
              >
                <mod.Component />
              </Suspense>
            </ModuleErrorBoundary>
          </div>
        </OverlayProvider>
      </ModuleActionsProvider>
    </ShellChromeProvider>
  );
}
