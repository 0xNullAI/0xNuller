import { Suspense, useCallback, useEffect, useState } from 'react';
import {
  useTheme,
  ShellChromeProvider,
  ModuleActionsProvider,
  useModuleActionsContainer,
  SidebarSectionsProvider,
  OverlayProvider,
  useOverlayRoot,
  useModuleOverlayLayer,
} from '@0xnullai/ui';
import { me, type AuthUser } from '@0xnullai/auth';
import { MODULES, moduleIdFromPath } from './routes';
import { Home } from './Home';
import { Sidebar } from './Sidebar';
import { DeviceBar } from './DeviceBar';
import { AccountDialog } from './AccountDialog';
import { SettingsPanel } from './settings/SettingsPanel';
import { ModuleErrorBoundary } from './ModuleErrorBoundary';
import { FirstConnectionNotice } from './FirstConnectionNotice';
import { DocsDialog } from './DocsDialog';
import { grantDeviceLease } from '@dg-kit/safety';

/**
 * 统一外壳。**两列**：左侧边栏 + 右内容区，没有顶部横栏。
 *
 * 顶栏取消的理由不只是省一条：模块自己也各有一条 header，两条上下叠着，模块名还和
 * 外壳导航里高亮的那一项重复。现在应用切换在侧边栏顶部（点名字弹出），模块自己的
 * 按钮投到内容区顶部，屏幕高度全部还给内容。
 *
 * 上一次外壳失败在三个地方，都已在契约层解决：
 * 1. **Tailwind 扫描根被顶掉** —— shell.css 里为每个模块显式 @source。加新模块必须
 *    同步加一行，漏掉表现为该模块工具类被静默 tree-shake 而构建全绿。
 * 2. **覆盖层逃逸** —— overlay 容器挂在外壳根的兄弟位置，模块弹窗全部 portal 过去。
 * 3. **模块根写死 100dvh** —— 模块根一律 h-full。
 *
 * 模块**一旦打开就保持挂载**，切走只是隐藏——BLE 连接与模块状态都活着。这是把它们
 * 放进同一个 origin 唯一无法被替代的收益。
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

/** 路由与「已打开模块」放在同一份 state，同一次状态转换中更新——放 ref 是渲染期写
 *  ref（并发渲染下不安全），单独放 state 再用 effect 补写会多一次级联渲染。 */
function useHistoryRoute(): [RouteState, (path: string) => void] {
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
    if (window.location.pathname === path) return;
    window.history.pushState(null, '', path);
    setState((prev) => nextState(prev, path));
  }, []);

  return [state, navigate];
}

/** 窄屏的判定。侧边栏在这个宽度以下变成抽屉而不是压扁成一条。 */
const NARROW_QUERY = '(max-width: 767px)';

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function Shell() {
  const [{ pathname, opened }, navigate] = useHistoryRoute();
  const activeId = moduleIdFromPath(pathname);
  const overlayRoot = useOverlayRoot();
  const narrow = useIsNarrow();
  // 主题由 @0xnullai/ui 的共享 store 唯一持有——外壳和模块看到同一个值。
  useTheme();

  const [user, setUser] = useState<AuthUser | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  // 窄屏下侧边栏默认收起（抽屉关着），宽屏默认展开。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [actionsRef, actionsContainer] = useModuleActionsContainer();

  // 设备控制权跟着当前模块走。切走的模块立刻失去控制权——房间里其他人的指令、
  // 后台 AI 的指令都会被硬拒绝，而不只是 UI 上看不到按钮。
  //
  // **交出控制权不等于断开设备**：设备栏与停止按钮照常显示，只是没有模块能下指令。
  useEffect(() => {
    void grantDeviceLease(activeId);
  }, [activeId]);

  useEffect(() => {
    // 账号服务不可用时当作未登录——不能因为它抖动就挡住匿名使用。
    me()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  // 路由或断点一变就关抽屉，否则切走之后它还盖在内容上。
  //
  // 用「渲染期调整状态」而不是 effect：effect 里同步 setState 会多跑一次渲染+提交，
  // 用户能看到抽屉闪一下才关。这个写法 React 会在提交前就地重渲，没有中间帧。
  const [lastRoute, setLastRoute] = useState<{ id: string | null; narrow: boolean }>({
    id: activeId,
    narrow,
  });
  if (lastRoute.id !== activeId || lastRoute.narrow !== narrow) {
    setLastRoute({ id: activeId, narrow });
    if (drawerOpen) setDrawerOpen(false);
  }

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
      // 打开弹窗时顺手关抽屉。抽屉是导航面，弹窗一开就说明导航结束了；留着它会
      // 盖在弹窗上面（抽屉在 --z-shell，弹窗在 --z-module-overlay，抽屉更高）。
      onOpenAccount={() => {
        setDrawerOpen(false);
        setAccountOpen(true);
      }}
      onOpenSettings={() => {
        setDrawerOpen(false);
        setSettingsOpen(true);
      }}
      onOpenDocs={() => {
        setDrawerOpen(false);
        setDocsOpen(true);
      }}
      collapsed={!narrow && sidebarCollapsed}
      onToggleCollapsed={() => (narrow ? setDrawerOpen(false) : setSidebarCollapsed((v) => !v))}
    />
  );

  return (
    <SidebarSectionsProvider>
      <div
        id="shl-root"
        data-narrow={narrow || undefined}
        data-collapsed={(!narrow && sidebarCollapsed) || undefined}
      >
        {/* 宽屏：侧边栏是布局的一列。窄屏：它是覆盖在内容上的抽屉，不占布局宽度。 */}
        {!narrow && <div id="shl-side">{sidebar}</div>}

        <main id="shl-slot">
          <DeviceBar />

          {/* 模块自己的按钮落在这里。窄屏时抽屉开关也在这一行。 */}
          <div id="shl-actions">
            {narrow && (
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="打开侧边栏"
                className="shrink-0 rounded-[10px] px-2 py-1.5 text-sm font-bold tracking-tight transition-colors hover:bg-[var(--bg-soft)]"
              >
                {MODULES.find((m) => m.id === activeId)?.label ?? '0xNuller'}
              </button>
            )}
            <div className="min-w-0 flex-1" />
            <div ref={actionsRef} className="flex shrink-0 items-center gap-1" />
          </div>

          <div id="shl-content">
            {activeId === null ? <Home onOpen={go} /> : null}
            {opened.map((id) => {
              const mod = MODULES.find((m) => m.id === id);
              if (!mod) return null;
              return (
                <ModuleSlot
                  key={id}
                  mod={mod}
                  active={id === activeId}
                  overlayRoot={overlayRoot}
                  actionsContainer={id === activeId ? actionsContainer : null}
                />
              );
            })}
          </div>
        </main>

        {narrow && drawerOpen && (
          <>
            <div
              className="fixed inset-0 z-[var(--z-shell)] bg-[var(--overlay-scrim)]"
              onClick={() => setDrawerOpen(false)}
              aria-hidden
            />
            <div className="fixed inset-y-0 left-0 z-[calc(var(--z-shell)+1)] w-[min(280px,80vw)]">
              {sidebar}
            </div>
          </>
        )}

        <OverlayProvider container={overlayRoot}>
          {accountOpen && (
            <AccountDialog user={user} onUser={setUser} onClose={() => setAccountOpen(false)} />
          )}
          {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
          {docsOpen && <DocsDialog onClose={() => setDocsOpen(false)} />}
          {/* 安全须知在**首次连上设备**时出现一次，而不是开场弹窗。开场弹窗打扰了
              只想逛市场或看文档的人，而真正需要看到它的时刻是设备接到身上那一刻。
              注册流程里的用户协议是另一个落点——但账号是可选的，只放那儿等于让从不
              注册的人永远看不到。 */}
          <FirstConnectionNotice />
        </OverlayProvider>
      </div>
    </SidebarSectionsProvider>
  );
}

/**
 * 一个模块的槽位。
 *
 * 覆盖层用**每个模块独立的子层**，跟着模块一起显隐——弹窗 portal 出模块子树之后，
 * 模块容器上的 hidden 管不到它。实测症状：在 Chat 里打开弹窗再切到 Market，
 * Chat 的弹窗仍浮在 Market 上面且被挤成窄列。
 */
function ModuleSlot({
  mod,
  active,
  overlayRoot,
  actionsContainer,
}: {
  mod: (typeof MODULES)[number];
  active: boolean;
  overlayRoot: HTMLElement | undefined;
  actionsContainer: HTMLElement | null;
}) {
  const layer = useModuleOverlayLayer(overlayRoot, mod.id, active);
  return (
    <ShellChromeProvider>
      <ModuleActionsProvider container={actionsContainer}>
        <OverlayProvider container={layer}>
          <div
            hidden={!active}
            // 非当前模块留在 DOM 里但不可见——连接与状态都保住。
            // 不要在这里加 transform/filter 做切换动画：那会把模块内部依赖视口包含块
            // 的固定定位元素的基准翻转掉。要动就动 opacity。
            className={active ? 'h-full min-h-0' : 'hidden'}
            aria-hidden={!active}
          >
            {/* 边界在 Suspense 之内、模块之外：模块渲染期抛错只烧掉这一个槽位，
                外壳（连同设备栏上的停止按钮）必须活下来。 */}
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
