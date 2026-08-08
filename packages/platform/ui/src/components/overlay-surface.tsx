import type { ReactNode, MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayContainer } from '../overlay';
import { cn } from '../utils';

/**
 * 覆盖层容器：遮罩 + 居中 + portal。
 *
 * 合并前四个模块各自写 `<div className="fixed inset-0 z-50 flex items-center
 * justify-center bg-black/40 p-4">`，遮罩黑度有 /30 /38 /40 /50 /80 五种，
 * z 值有 50 和 60 两种，而且都不 portal——留在模块子树里，祖先有没有 transform
 * 决定了它是「盖住外壳」还是「关不住模态」。
 *
 * 用这个组件替代那一行，遮罩浓度与层级走令牌，portal 走外壳容器。独立运行时
 * 容器为 undefined，回落 document.body，行为不变。
 */

export interface OverlayProps {
  children: ReactNode;
  /** 点遮罩关闭。不传则遮罩不可关（用于必须显式确认的场景，如安全确认）。 */
  onDismiss?: () => void;
  /** 遮罩浓度。`strong` 用于需要遮蔽下方内容的场景（如图片查看器）。 */
  scrim?: 'default' | 'strong';
  /** 层级。默认走模块覆盖层；`stacked` 用于叠在另一个覆盖层之上的次级弹窗。 */
  level?: 'module' | 'stacked';
  className?: string;
}

export function Overlay({
  children,
  onDismiss,
  scrim = 'default',
  level = 'module',
  className,
}: OverlayProps) {
  const container = useOverlayContainer();

  function handleMouseDown(e: MouseEvent<HTMLDivElement>) {
    // 只在点到遮罩本身时关闭，点内容不关。
    if (onDismiss && e.target === e.currentTarget) onDismiss();
  }

  const node = (
    <div
      className={cn('fixed inset-0 flex items-center justify-center p-4', className)}
      style={{
        background:
          scrim === 'strong' ? 'var(--overlay-scrim-strong)' : 'var(--overlay-scrim)',
        zIndex: level === 'stacked' ? 'calc(var(--z-module-overlay) + 10)' : 'var(--z-module-overlay)',
        pointerEvents: 'auto',
      }}
      onMouseDown={handleMouseDown}
      role={onDismiss ? 'presentation' : undefined}
    >
      {children}
    </div>
  );

  return container ? createPortal(node, container) : node;
}
