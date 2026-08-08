import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * 覆盖层挂载点。
 *
 * 模块里的弹窗必须 portal 到这里，不能用 `position:fixed` 直接铺在模块子树里，
 * 也不能默认 portal 到 `document.body`。
 *
 * 为什么不能留在模块子树里：那些覆盖层现在处于**不稳定的中间态**。祖先没有
 * transform 时，它们的包含块是视口 → 全屏铺开、盖住外壳顶栏；外壳一旦给模块槽位
 * 加上 transform / filter / contain:paint（做切换动画最自然的写法），包含块就翻转
 * 成模块盒子 → 模态关不住，用户能点到弹窗外面去。两种失败都不能接受。
 *
 * 为什么容器要挂在外壳根的**兄弟**位置而不是后代：同样的道理——只要它不是槽位的
 * 后代，槽位上的任何 transform 都影响不到它。
 *
 * 独立运行（没有外壳）时 useOverlayContainer 返回 undefined，Radix 会回落到
 * document.body，行为与合并前一致。
 */

const OverlayContext = createContext<HTMLElement | undefined>(undefined);

/** 由外壳提供。传入外壳创建的、与外壳根同级的容器元素。 */
export function OverlayProvider({
  container,
  children,
}: {
  container: HTMLElement | undefined;
  children: ReactNode;
}) {
  return <OverlayContext.Provider value={container}>{children}</OverlayContext.Provider>;
}

/**
 * 取覆盖层容器。传给 Radix 的 `container` prop：
 * `<DialogPrimitive.Portal container={useOverlayContainer()}>`
 *
 * 返回 undefined 时 Radix 用 document.body，这正是独立运行的期望行为。
 */
export function useOverlayContainer(): HTMLElement | undefined {
  return useContext(OverlayContext);
}

/**
 * 创建一个与外壳根同级的覆盖层容器。外壳在挂载时调用一次。
 *
 * 容器本身 `pointer-events:none`，具体的覆盖层自己开 `pointer-events:auto`——
 * 这样没有弹窗时它不会吃掉整页的点击。
 */
export function useOverlayRoot(id = 'shl-overlay-root'): HTMLElement | undefined {
  const [el, setEl] = useState<HTMLElement>();

  useEffect(() => {
    let node = document.getElementById(id);
    let created = false;
    if (!node) {
      node = document.createElement('div');
      node.id = id;
      node.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
      document.body.appendChild(node);
      created = true;
    }
    setEl(node);
    return () => {
      if (created && node?.parentNode) node.parentNode.removeChild(node);
    };
  }, [id]);

  return el;
}


/**
 * 每个模块一个覆盖层子层，由外壳按当前模块显隐。
 *
 * 为什么需要：弹窗一旦 portal 出模块子树，模块容器上的 `hidden` 就管不到它了。
 * 实测症状是——在 Chat 里打开安全确认后切到 Market，Chat 的弹窗仍然浮在 Market
 * 上面，还被挤成一条窄列。给每个模块一个子层、跟着模块一起显隐，才能让「切走的
 * 模块保持挂载」与「切走的模块不该冒出弹窗」同时成立。
 */
export function useModuleOverlayLayer(
  root: HTMLElement | undefined,
  moduleId: string,
  active: boolean,
): HTMLElement | undefined {
  const [el, setEl] = useState<HTMLElement>();

  useEffect(() => {
    if (!root) return;
    const node = document.createElement('div');
    node.dataset.overlayLayer = moduleId;
    node.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    root.appendChild(node);
    setEl(node);
    return () => {
      node.remove();
      setEl(undefined);
    };
  }, [root, moduleId]);

  useEffect(() => {
    if (!el) return;
    // 用 display 而不是 visibility：隐藏层里的元素不应参与命中测试，也不该被
    // 屏幕阅读器读到。
    el.style.display = active ? '' : 'none';
  }, [el, active]);

  return el;
}
