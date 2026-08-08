import { Suspense, useCallback, useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import {
  useTheme,
  ShellChromeProvider,
  ModuleActionsProvider,
  useModuleActionsContainer,
  SafetyNotice,
  OverlayProvider,
  useOverlayRoot,
  useModuleOverlayLayer,
  EmergencyStopButton,
} from '@0xnullai/ui';
import { MODULES, moduleIdFromPath } from './routes';
import { Home } from './Home';
import { AccountMenu } from './AccountMenu';
import { ModuleErrorBoundary } from './ModuleErrorBoundary';
import { isSafetyNoticeAccepted, rememberSafetyNoticeAccepted } from '@dg-kit/safety';

/**
 * 统一外壳。
 *
 * 上一次的外壳失败在三个地方，这次全部在契约层面解决：
 *
 * 1. **Tailwind 扫描根被顶掉** —— 外壳的 Vite root 是 apps/web，模块源码树不在扫描
 *    范围内，Agent 的候选类从 2199 掉到 409，整条高度锁与 min-h-0 消失。修法是
 *    shell.css 里为每个模块显式 @source，见那里的注释。
 * 2. **覆盖层逃逸** —— 模块弹窗用裸 fixed，盖住外壳顶栏；而外壳一旦给槽位加
 *    transform 又会翻转成「关不住模态」。修法是 overlay 容器挂在外壳根的**兄弟**
 *    位置，模块弹窗全部 portal 过去。
 * 3. **模块根写死 100dvh** —— 在外壳里比槽位高出一个导航条，被 body{overflow:hidden}
 *    裁掉且滚不到。修法是模块根一律 h-full，独立运行时由 base.css 的
 *    html,body,#root{height:100%} 解析成视口高度。
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

export function Shell() {
  const [{ pathname, opened }, navigate] = useHistoryRoute();
  const activeId = moduleIdFromPath(pathname);
  const overlayRoot = useOverlayRoot();
  // 主题由 @0xnullai/ui 的共享 store 唯一持有——外壳和四个模块看到同一个值，
  // 切模块不会把它顶回去。
  const { effective, toggle: toggleTheme } = useTheme();
  // 全系统唯一的一道安全门：进主界面时确认一次，之后所有模块都算已确认。
  // 各模块**不再**各设一道——同一份协议确认三遍只会训练用户无脑点掉它。
  const [safetyAccepted, setSafetyAccepted] = useState(isSafetyNoticeAccepted);
  // 模块把自己的顶栏按钮投进这个容器——全局只有一条横栏。
  const [actionsRef, actionsContainer] = useModuleActionsContainer();

  return (
    <div id="shl-root">
      <header className="flex shrink-0 items-center gap-1 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mr-2 shrink-0 rounded-[10px] px-2 py-1 font-semibold tracking-tight transition-colors hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          0xNullAI
        </button>

        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {MODULES.map((m) => (
            <button
              key={m.id}
              type="button"
              title={m.blurb}
              aria-current={activeId === m.id ? 'page' : undefined}
              onClick={() => navigate(`/${m.id}`)}
              className={
                'shrink-0 rounded-[10px] px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ' +
                (activeId === m.id
                  ? 'bg-[var(--accent-soft)] font-medium text-[var(--text)]'
                  : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]')
              }
            >
              {m.label}
            </button>
          ))}
        </nav>

        {/* 当前模块的按钮落在这里。模块自己不再画 header，所以全局只有这一条栏。 */}
        <div ref={actionsRef} className="flex shrink-0 items-center gap-1" />

        {/* 全局停止锚点。模块被切走后会隐藏，它自己的停止按钮就点不到了，但设备
              仍在输出——这个按钮不随模块显隐而消失。没有活动会话时它不渲染。 */}
        <EmergencyStopButton className="mx-1 shrink-0" />

        <AccountMenu />

        <button
          type="button"
          onClick={toggleTheme}
          title={effective === 'dark' ? '切换到浅色' : '切换到深色'}
          className="ml-1 shrink-0 rounded-[10px] p-2 text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {effective === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </header>

      <main id="shl-slot">
        {activeId === null ? <Home onOpen={(id) => navigate(`/${id}`)} /> : null}

        {opened.map((id) => {
          const mod = MODULES.find((m) => m.id === id);
          if (!mod) return null;
          return (
            <ModuleSlot
              key={id}
              mod={mod}
              active={id === activeId}
              overlayRoot={overlayRoot}
              // 只有当前模块把按钮投上去——否则后台模块的按钮也会挤进那条栏。
              actionsContainer={id === activeId ? actionsContainer : null}
            />
          );
        })}
      </main>

      {/* 安全门挂在外壳根，用外壳自己的覆盖层容器——它必须盖住顶栏，而且不属于任何
          一个模块（模块可能都还没打开）。 */}
      {!safetyAccepted && (
        <OverlayProvider container={overlayRoot}>
          <SafetyNotice
            moduleId={activeId ?? undefined}
            onAccept={({ dontShowAgain }) => {
              if (dontShowAgain) rememberSafetyNoticeAccepted();
              setSafetyAccepted(true);
            }}
          />
        </OverlayProvider>
      )}
    </div>
  );
}

/**
 * 一个模块的槽位。
 *
 * 覆盖层用**每个模块独立的子层**，跟着模块一起显隐——弹窗 portal 出模块子树之后，
 * 模块容器上的 hidden 管不到它。实测症状：在 Chat 里打开安全确认再切到 Market，
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
    // ShellChromeProvider 让模块知道自己不是独立运行，于是隐藏与外壳顶栏重复的
    // 应用切换器和主题按钮。独立部署时没有这个 Provider，模块的顶栏原样保留。
    <ShellChromeProvider>
      <ModuleActionsProvider container={actionsContainer}>
        <OverlayProvider container={layer}>
        <div
          hidden={!active}
          // 非当前模块留在 DOM 里但不可见——连接与状态都保住。
          // 不要在这里加 transform/filter 做切换动画：那会把模块内部依赖视口包含块的
          // 固定定位元素的基准翻转掉。要动就动 opacity。
          className={active ? 'h-full min-h-0' : 'hidden'}
          aria-hidden={!active}
        >
          {/* 边界在 Suspense 之内、模块之外：模块渲染期抛错只烧掉这一个槽位，
              外壳顶栏（连同全局急停按钮）必须活下来。 */}
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
