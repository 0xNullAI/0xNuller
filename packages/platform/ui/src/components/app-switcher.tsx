import { useEffect, useId, useRef, useState } from 'react';

/**
 * 应用切换器。
 *
 * 四个应用在软件层面是分开的（各自的域名、设置、主题、部署），所以这里是**真跳转**
 * 而不是共享文档——曾经试过把它们挂进同一个外壳，四套 CSS 体系互相覆盖，Market 白屏、
 * Chat 弹窗逃逸、Agent 布局塌陷。切换器只占标题这一个位置，风险收敛在一个组件里。
 *
 * 样式不用 Tailwind，只用设计令牌写普通 CSS：Market 那套 646 行的独立体系里没有
 * Tailwind，组件必须在四种 CSS 环境下都长得对。
 */

export interface AppTarget {
  id: string;
  /** 下拉里显示的名字。 */
  label: string;
  /** 一句话说明它解决什么问题。 */
  blurb: string;
  /** 生产地址。 */
  url: string;
}

export const APP_TARGETS: AppTarget[] = [
  { id: 'agent', label: 'DG-Agent', blurb: '对话控制设备', url: 'https://agent.0xnullai.com' },
  { id: 'chat', label: 'DG-Chat', blurb: '多人房间远程控制', url: 'https://chat.0xnullai.com' },
  { id: 'voice', label: 'DG-Voice', blurb: '实时语音通话', url: 'https://voice.0xnullai.com' },
  { id: 'market', label: 'DG-Market', blurb: '波形与场景社区', url: 'https://market.0xnullai.com' },
  { id: 'wiki', label: 'DG-Wiki', blurb: '文档', url: 'https://wiki.0xnullai.com' },
];

interface Props {
  /** 当前应用 id，用来标出「就在这里」并作为默认标题。 */
  current: string;
  /**
   * 覆盖各应用地址。本地同时起多个 dev server 时用得上，
   * 例如 `{ chat: 'http://localhost:5172' }`。
   */
  urls?: Partial<Record<string, string>>;
  /** 覆盖触发器上显示的文字，默认用当前应用的 label。 */
  label?: string;
  className?: string;
}

export function AppSwitcher({ current, urls, label, className }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const currentApp = APP_TARGETS.find((a) => a.id === current);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={`dgx-switcher${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className="dgx-switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dgx-switcher-label">{label ?? currentApp?.label ?? current}</span>
        <svg
          className={`dgx-switcher-caret${open ? ' is-open' : ''}`}
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div className="dgx-switcher-menu" id={menuId} role="menu">
          {APP_TARGETS.map((app) => {
            const here = app.id === current;
            const href = urls?.[app.id] ?? app.url;
            return (
              <a
                key={app.id}
                role="menuitem"
                href={here ? undefined : href}
                aria-current={here ? 'page' : undefined}
                className={`dgx-switcher-item${here ? ' is-current' : ''}`}
                onClick={() => setOpen(false)}
              >
                <span className="dgx-switcher-item-label">{app.label}</span>
                <span className="dgx-switcher-item-blurb">{here ? '就在这里' : app.blurb}</span>
              </a>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
