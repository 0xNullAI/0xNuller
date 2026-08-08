import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * 侧边栏分区。
 *
 * 分区顺序、标题排版、折叠行为都归外壳；模块只提供列表项本身。三个模块各画各的
 * 列表就又回到了「五套 UI」。
 *
 * 走 portal 而不是「模块注册一个 render 函数」：后者要求外壳在模块状态变化时重渲，
 * 而外壳并不知道模块的状态。第一版就是这么写的，结果是**分区永远不出现**——
 * Provider 自己 setState 时 children 是同一个元素引用，React 直接跳过整棵子树，
 * 而 context value 又被 useMemo 固定住了，消费者也收不到通知。portal 让内容跟着
 * **模块自己**的渲染周期走，没有这层协调问题。
 *
 * 分区只有三种：置顶 / 对话 / 房间。场景不在侧边栏（它属于内容区）。
 */

export type SidebarSectionId = 'pinned' | 'conversations' | 'rooms';

/** 渲染顺序。置顶在最上——用户收藏的东西应该一眼看到。 */
const ORDER: SidebarSectionId[] = ['pinned', 'conversations', 'rooms'];

interface SidebarRegistry {
  /** 被模块声明使用的分区及其标题。决定外壳要不要画这个分区的标题。 */
  claims: Partial<Record<SidebarSectionId, string>>;
  claim: (id: SidebarSectionId, title: string) => void;
  release: (id: SidebarSectionId) => void;
  containers: Partial<Record<SidebarSectionId, HTMLElement>>;
  setContainer: (id: SidebarSectionId, el: HTMLElement | null) => void;
}

const Ctx = createContext<SidebarRegistry | null>(null);

export function SidebarSectionsProvider({ children }: { children: ReactNode }) {
  const [claims, setClaims] = useState<Partial<Record<SidebarSectionId, string>>>({});
  const [containers, setContainers] = useState<Partial<Record<SidebarSectionId, HTMLElement>>>({});

  const claim = useCallback((id: SidebarSectionId, title: string) => {
    setClaims((prev) => (prev[id] === title ? prev : { ...prev, [id]: title }));
  }, []);

  const release = useCallback((id: SidebarSectionId) => {
    setClaims((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const setContainer = useCallback((id: SidebarSectionId, el: HTMLElement | null) => {
    setContainers((prev) => {
      if (prev[id] === (el ?? undefined)) return prev;
      const next = { ...prev };
      if (el) next[id] = el;
      else delete next[id];
      return next;
    });
  }, []);

  const value = useMemo<SidebarRegistry>(
    () => ({ claims, claim, release, containers, setContainer }),
    [claims, claim, release, containers, setContainer],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 外壳侧：当前被声明使用的分区，按固定顺序。 */
export function useClaimedSidebarSections(): { id: SidebarSectionId; title: string }[] {
  const ctx = useContext(Ctx);
  return useMemo(() => {
    if (!ctx) return [];
    return ORDER.flatMap((id) => {
      const title = ctx.claims[id];
      return title ? [{ id, title }] : [];
    });
  }, [ctx]);
}

/**
 * 外壳侧：把某个分区的容器元素登记上来，模块的内容会 portal 进去。
 *
 * 依赖 `setContainer` 这个**稳定引用**，绝不能依赖 ctx 本身。ctx 的身份随 containers
 * 变化，而 ref 回调身份一变 React 就会用 null 调旧的、用元素调新的——于是
 * setContainer(null) → containers 变 → ctx 变 → 新回调 → setContainer(el) → 再变，
 * 无限循环（实测就是 React #185，整页空白）。
 */
export function useSidebarContainerRef(id: SidebarSectionId): (el: HTMLElement | null) => void {
  const setContainer = useContext(Ctx)?.setContainer;
  return useCallback((el: HTMLElement | null) => setContainer?.(id, el), [setContainer, id]);
}

/**
 * 模块侧：声明一个分区并把内容投进去。
 *
 * 独立于外壳运行时（无 Provider）什么都不渲染——不是回落成内联，因为侧边栏是外壳的
 * 结构，模块自己没有可放的位置。
 */
export function SidebarSection({
  id,
  title,
  children,
}: {
  id: SidebarSectionId;
  title: string;
  children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  // 依赖这两个**稳定引用**而不是 ctx 本身：ctx 的身份随 claims/containers 变化，
  // 把它放进依赖会变成 claim → 新 ctx → 重新 claim 的循环。
  const claim = ctx?.claim;
  const release = ctx?.release;

  useEffect(() => {
    if (!claim || !release) return;
    claim(id, title);
    return () => release(id);
  }, [claim, release, id, title]);

  const container = ctx?.containers[id];
  return container ? createPortal(children, container) : null;
}
