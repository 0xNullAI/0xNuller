import { Suspense, useCallback, useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { applyTheme, subscribeThemeChanges } from '@0xnullai/ui';
import { MODULES, moduleIdFromPath } from './routes';
import { Home } from './Home';

/**
 * 统一外壳。
 *
 * 它只接管三件事：模块切换、主题、以及未来的设备状态与账号入口。四个模块各自的
 * 内部 chrome（Agent 的抽屉与浮动输入区、Chat 的双栏、Voice 的通话视图、Market
 * 的分类标签）一律不动。
 *
 * 关键设计：**模块一旦打开就保持挂载**，切走只是 CSS 隐藏。
 * 合并前四个模块是四个独立站点，切换等于整页跳转，浏览器会销毁页面——BLE 连接
 * 随之断开，回来要重连。保持挂载让 React 树和设备连接都活着，这是把四个模块放进
 * 同一个 origin 唯一无法被替代的收益；如果切模块仍然断线，单页合并就白做了。
 * 代价是内存里会同时存在多棵 React 树，所以只对**真正打开过**的模块付这份代价。
 */

interface RouteState {
  pathname: string;
  /** 已经打开过的模块，按首次打开顺序。它们会一直留在 DOM 里。 */
  opened: string[];
}

function nextState(prev: RouteState, pathname: string): RouteState {
  const id = moduleIdFromPath(pathname);
  const opened = id && !prev.opened.includes(id) ? [...prev.opened, id] : prev.opened;
  return { pathname, opened };
}

/**
 * 路由与「已打开模块」放在同一份 state 里，在同一次状态转换中更新。
 *
 * 曾经把 opened 单独放 state 再用 effect 补写，那会多一次级联渲染；放 ref 则是
 * 渲染期写 ref，在并发渲染下不安全。合成一份是唯一没有副作用的写法。
 */
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
  const [theme, setTheme] = useState<'dark' | 'light' | 'auto'>(
    () => (localStorage.getItem('0xnullai-theme') as 'dark' | 'light' | 'auto') ?? 'auto',
  );

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('0xnullai-theme', theme);
    return subscribeThemeChanges(theme, () => applyTheme(theme));
  }, [theme]);

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="flex shrink-0 items-center gap-1 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mr-2 shrink-0 rounded-[10px] px-2 py-1 font-semibold tracking-tight text-[var(--text)] transition-colors hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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

        {/*
          设备状态条的位置。现在留空是有意的：四个模块各自持有自己的设备连接，
          外壳还没有共享的 device session，放一个假的状态条会让用户以为它是全局的。
          等设备层收口之后再填。
        */}

        <button
          type="button"
          onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          title={theme === 'light' ? '切换到深色' : '切换到浅色'}
          className="ml-1 shrink-0 rounded-[10px] p-2 text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </button>
      </header>

      <main className="relative min-h-0 flex-1">
        {activeId === null ? <Home onOpen={(id) => navigate(`/${id}`)} /> : null}

        {opened.map((id) => {
          const mod = MODULES.find((m) => m.id === id);
          if (!mod) return null;
          const active = id === activeId;
          return (
            <div
              key={id}
              hidden={!active}
              // 非当前模块留在 DOM 里但不可见、不可聚焦——连接与状态都保住。
              className={active ? 'h-full min-h-0' : 'hidden'}
              aria-hidden={!active}
            >
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-sm text-[var(--text-faint)]">
                    正在加载 {mod.label}…
                  </div>
                }
              >
                <mod.Component />
              </Suspense>
            </div>
          );
        })}
      </main>
    </div>
  );
}
