import { PersistenceNotice } from './PersistenceNotice';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { LogIn, Menu } from 'lucide-react';
import {
  useTheme,
  subscribeMediaQuery,
  stopAllDevices,
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
  Z_SHELL,
  Z_SHELL_PANEL,
} from '@0xnullai/ui';
import {
  me,
  subscribeProfileChanges,
  subscribeProfileRequests,
  type AuthUser,
} from '@0xnullai/auth';
import { MODULES, moduleIdFromPath } from './routes';
import { Home } from './Home';
import { Sidebar } from './Sidebar';
import { DeviceBar } from './DeviceBar';
const ContactsDialog = lazy(() =>
  import('./ContactsDialog').then((module) => ({ default: module.ContactsDialog })),
);
const ProfileDialog = lazy(() =>
  import('./profile/ProfileDialog').then((module) => ({ default: module.ProfileDialog })),
);
const SettingsPanel = lazy(() =>
  import('./settings/SettingsPanel').then((module) => ({ default: module.SettingsPanel })),
);
import { ModuleErrorBoundary } from './ModuleErrorBoundary';
const DocsDialog = lazy(() =>
  import('./DocsDialog').then((module) => ({ default: module.DocsDialog })),
);
import { grantDeviceLease } from '@dg-kit/safety';

/**
 * The unified shell. **Two columns**: sidebar on the left, content area on the
 * right, no top bar.
 *
 * Dropping the top bar was not only about saving one strip: every module already
 * has a header of its own, so two of them ended up stacked, and the module name
 * duplicated the item highlighted in the shell navigation. App switching now
 * lives at the top of the sidebar (click the name to open it), the module's own
 * buttons are projected into the top of the content area, and all the screen
 * height goes back to the content.
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
  const id = moduleIdFromPath(pathname);
  const opened = id && !prev.opened.includes(id) ? [...prev.opened, id] : prev.opened;
  return { pathname, opened };
}

/** The route and the set of opened modules live in one piece of state and are
 *  updated in the same transition — a ref would mean writing a ref during render
 *  (unsafe under concurrent rendering), and keeping it in separate state written
 *  back from an effect would cost an extra cascading render. */
function useHistoryRoute(): [RouteState, (path: string) => void, (moduleId: string) => void] {
  const [state, setState] = useState<RouteState>(() =>
    nextState(
      { pathname: '/', opened: [] },
      typeof window === 'undefined' ? '/' : window.location.pathname,
    ),
  );

  useEffect(() => {
    const sync = () => setState((prev) => nextState(prev, window.location.pathname));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const navigate = useCallback((path: string) => {
    const target = new URL(path, window.location.href);
    if (
      `${window.location.pathname}${window.location.search}` ===
      `${target.pathname}${target.search}`
    )
      return;
    window.history.pushState(null, '', path);
    setState((prev) => nextState(prev, target.pathname));
  }, []);

  const ensureModuleOpened = useCallback((moduleId: string) => {
    setState((prev) =>
      prev.opened.includes(moduleId) ? prev : { ...prev, opened: [...prev.opened, moduleId] },
    );
  }, []);

  return [state, navigate, ensureModuleOpened];
}

/** The narrow-screen test. Below this width the sidebar becomes a drawer instead
 *  of being squeezed into a sliver. */
const NARROW_QUERY = '(max-width: 767px)';

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
  const overlayRoot = useOverlayRoot();
  const narrow = useIsNarrow();
  // The theme is held solely by the shared store in @0xnullai/ui — the shell and the
  // modules see the same value.
  useTheme();

  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<ShellSettingsTab | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return pathname === '/settings' || params.has('verify') || params.has('reset')
      ? 'account'
      : null;
  });
  const [docsOpen, setDocsOpen] = useState(() => pathname === '/wiki');
  // Whose profile is open, by username. The shell owns this surface because it
  // is reachable from Chat's member list, from contacts and from the account
  // dialog, and there must be exactly one of it.
  const [profileUsername, setProfileUsername] = useState<string | null>(null);
  // On narrow screens the sidebar defaults to collapsed (drawer closed); on wide
  // screens it defaults to expanded.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

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
    void grantDeviceLease(activeId);
  }, [activeId]);

  useEffect(() => {
    // Treat an unavailable account service as signed out. Chat is account-only,
    // while the other modules remain available.
    me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(
    () =>
      subscribeProfileChanges(() => {
        void me()
          .then(setUser)
          .catch(() => undefined);
      }),
    [],
  );

  // Modules ask for a profile rather than rendering one; see profile-requests
  // in @0xnullai/auth. Subscribing here rather than inside a module is what
  // keeps a lazily-mounted module from needing a provider threaded into it.
  useEffect(
    () =>
      subscribeProfileRequests((username) => {
        setDrawerOpen(false);
        setProfileUsername(username);
      }),
    [],
  );

  // Close the drawer as soon as the route or the breakpoint changes, otherwise it
  // stays covering the content after the switch.
  //
  // This adjusts state during render rather than in an effect: a synchronous setState
  // inside an effect costs an extra render + commit, and the user sees the drawer
  // flash before it closes. Written this way React re-renders in place before the
  // commit, so there is no intermediate frame.
  const [lastRoute, setLastRoute] = useState<{ id: string | null; narrow: boolean }>({
    id: activeId,
    narrow,
  });
  if (lastRoute.id !== activeId || lastRoute.narrow !== narrow) {
    setLastRoute({ id: activeId, narrow });
    if (drawerOpen) setDrawerOpen(false);
  }

  useEffect(() => {
    if (!narrow || !drawerOpen) return;
    const drawerTrigger = drawerTriggerRef.current;
    const focusTimer = window.setTimeout(() => {
      drawerRef.current?.querySelector<HTMLElement>('button, a[href]')?.focus();
    }, 0);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
      if (event.key === 'Tab') {
        const controls = [
          ...(drawerRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]') ??
            []),
        ].filter((el) => el.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', closeOnEscape);
      drawerTrigger?.focus();
    };
  }, [drawerOpen, narrow]);

  // Where a module's UI needs a settings entry point (the Chat host's button for
  // configuring the AI), it opens **this** panel instead of the module standing up
  // one of its own. What a module gets is the position of the entry point, not a
  // second settings UI.
  const openSettings = useCallback((tab: ShellSettingsTab = 'appearance') => {
    setDrawerOpen(false);
    setSettingsTab(tab);
  }, []);

  const go = useCallback(
    (moduleId: string | null) => {
      navigate(moduleId ? `/${moduleId}` : '/');
      setDrawerOpen(false);
    },
    [navigate],
  );

  const sidebar = (
    <Sidebar
      activeId={activeId}
      onNavigate={go}
      user={user}
      // Close the drawer whenever a dialog opens. The drawer is the navigation
      // surface, and opening a dialog means navigation is over; leaving it up would
      // cover the dialog (the drawer sits at --z-shell, dialogs at
      // --z-module-overlay, so the drawer is higher).
      onOpenAccount={() => {
        openSettings('account');
      }}
      onOpenContacts={() => {
        setDrawerOpen(false);
        setContactsOpen(true);
      }}
      onOpenSettings={() => {
        openSettings('appearance');
      }}
      onOpenDocs={() => {
        setDrawerOpen(false);
        setDocsOpen(true);
      }}
      onCreateRoom={() => {
        navigate('/chat?create=1');
        setDrawerOpen(false);
      }}
      collapsed={!narrow && sidebarCollapsed}
      onToggleCollapsed={() => (narrow ? setDrawerOpen(false) : setSidebarCollapsed((v) => !v))}
    />
  );

  return (
    <ModuleSettingsProvider>
      <SidebarSectionsProvider>
        <div
          id="shl-root"
          data-narrow={narrow || undefined}
          data-collapsed={(!narrow && sidebarCollapsed) || undefined}
        >
          {/* Wide screens: the sidebar is one of the layout columns. Narrow screens: it
            is a drawer over the content and takes up no layout width. */}
          {!narrow && <div id="shl-side">{sidebar}</div>}

          <main
            id="shl-slot"
            inert={narrow && drawerOpen}
            aria-label={MODULES.find((module) => module.id === activeId)?.label ?? '首页'}
          >
            {/* Wide screens stack module actions above device state. Narrow screens use
              the same wrapper as one compact toolbar, while the device section keeps
              its own horizontal overflow for multiple connected devices. */}
            <div id="shl-topbar">
              <div id="shl-actions">
                {narrow && (
                  <button
                    ref={drawerTriggerRef}
                    type="button"
                    onClick={() => setDrawerOpen(true)}
                    aria-label="打开侧边栏"
                    aria-controls="shl-drawer"
                    aria-expanded={drawerOpen}
                    // With only the module name, the top of a narrow screen is a couple of
                    // lone words and nobody can tell they are tappable.
                    // The touch target also has to be big enough: 44px is the lower bound
                    // both iOS and Android recommend.
                    className="flex min-h-[44px] shrink-0 items-center gap-2 rounded-[var(--radius-ctl)] px-2 text-sm font-bold tracking-tight transition-colors hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    <Menu className="h-[18px] w-[18px] shrink-0 text-[var(--text-soft)]" />
                    <span className="truncate">
                      {MODULES.find((m) => m.id === activeId)?.label ?? '0xNuller'}
                    </span>
                  </button>
                )}
                <div className="min-w-0 flex-1" />
                <div ref={actionsRef} className="flex shrink-0 items-center gap-1" />
              </div>

              <DeviceBar activeSessionId={activeId} showConnect={activeId !== 'control'} />
            </div>

            <PersistenceNotice />
            <div id="shl-content">
              {activeId === null ? <Home onOpen={go} /> : null}
              {opened.map((id) => {
                const mod = MODULES.find((m) => m.id === id);
                if (!mod) return null;
                if (mod.id === 'chat' && (!authChecked || !user || !user.emailVerified)) {
                  return (
                    <div
                      key={id}
                      hidden={id !== activeId}
                      className={id === activeId ? 'h-full min-h-0' : 'hidden'}
                    >
                      <ChatAccountGate
                        loading={!authChecked}
                        emailVerificationRequired={Boolean(user && !user.emailVerified)}
                        onLogin={() => openSettings('account')}
                      />
                    </div>
                  );
                }
                return (
                  <ModuleSlot
                    key={id}
                    mod={mod}
                    active={id === activeId}
                    overlayRoot={overlayRoot}
                    actionsContainer={id === activeId ? actionsContainer : null}
                    openSettings={openSettings}
                    signedIn={!!user}
                  />
                );
              })}
            </div>
          </main>

          {narrow && drawerOpen && (
            <>
              <div
                className={`fixed inset-0 ${Z_SHELL} bg-[var(--overlay-scrim)]`}
                onClick={() => setDrawerOpen(false)}
                aria-hidden
              />
              <aside
                ref={drawerRef}
                id="shl-drawer"
                aria-label="主导航"
                className={`shl-drawer flex flex-col fixed inset-y-0 left-0 ${Z_SHELL_PANEL} w-[min(280px,80vw)]`}
              >
                <div className="min-h-0 flex-1">{sidebar}</div>
                <button
                  type="button"
                  onClick={() => void stopAllDevices()}
                  className="m-2 min-h-11 rounded-[var(--radius-ctl)] bg-[var(--danger-button)] px-3 text-white"
                >
                  紧急停止全部设备
                </button>
              </aside>
            </>
          )}

          <OverlayProvider container={overlayRoot}>
            <ModuleErrorBoundary moduleId="settings" label="窗口">
              <Suspense
                fallback={
                  <div
                    role="status"
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--overlay-scrim)]"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSettingsTab(null);
                        setDocsOpen(false);
                        setContactsOpen(false);
                        setProfileUsername(null);
                      }}
                    >
                      正在加载… 点击取消
                    </button>
                  </div>
                }
              >
                {/* Signed-in only, and gated on `user` here as well as in the menu:
              signing out while the dialog is open has to close it rather than
              leave a surface up with nothing left to show. */}
                {contactsOpen && user && (
                  <ContactsDialog user={user} onClose={() => setContactsOpen(false)} />
                )}
                {settingsTab && (
                  <SettingsPanel
                    initialTab={settingsTab}
                    onLoadAgent={() => ensureModuleOpened('agent')}
                    user={user}
                    onUser={setUser}
                    onClose={() => setSettingsTab(null)}
                  />
                )}
                {docsOpen && (
                  <DocsDialog
                    onClose={() => {
                      setDocsOpen(false);
                      if (pathname === '/wiki') navigate('/');
                    }}
                  />
                )}
                {/* Public profiles remain readable while signed out. */}
                {profileUsername && (
                  <ProfileDialog
                    username={profileUsername}
                    viewer={user}
                    onClose={() => setProfileUsername(null)}
                  />
                )}
              </Suspense>
            </ModuleErrorBoundary>
          </OverlayProvider>

          {/* Outside the overlay provider on purpose. The overlay container is
            per-module and gets hidden when you switch modules, but "a device
            did not stop" outlives whichever module was showing — and it has
            to stay reachable while a dialog is open, which is why it sits at
            the top of the z scale rather than in the overlay layer. */}
          <StopFailureBanner />
        </div>
      </SidebarSectionsProvider>
    </ModuleSettingsProvider>
  );
}

function ChatAccountGate({
  loading,
  emailVerificationRequired,
  onLogin,
}: {
  loading: boolean;
  emailVerificationRequired: boolean;
  onLogin: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-xl font-semibold">
          {loading
            ? '正在检查账户…'
            : emailVerificationRequired
              ? '验证邮箱后使用 Chat'
              : '登录后使用 Chat'}
        </h1>
        {!loading && (
          <button
            type="button"
            onClick={onLogin}
            className="flex items-center gap-2 rounded-[var(--radius-ctl)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--button-text)]"
          >
            <LogIn className="h-4 w-4" />
            {emailVerificationRequired ? '前往账户验证' : '登录 / 注册'}
          </button>
        )}
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
  overlayRoot,
  actionsContainer,
  openSettings,
  signedIn,
}: {
  mod: (typeof MODULES)[number];
  active: boolean;
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
            // Do not add transform/filter here for a switch animation: that flips the
            // reference frame for fixed-position elements inside the module that rely
            // on the viewport as their containing block. Animate opacity instead.
            className={active ? 'h-full min-h-0' : 'hidden'}
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
