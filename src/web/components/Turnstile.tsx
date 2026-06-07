import { useEffect, useRef } from 'react';

interface TurnstileApi {
  render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void; theme?: string }) => string;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface Props {
  siteKey: string;
  onToken: (token: string) => void;
}

// 渲染 Cloudflare Turnstile 小组件（脚本在 index.html 已加载）。
export function Turnstile({ siteKey, onToken }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let widgetId: string | undefined;
    let cancelled = false;

    const tryRender = () => {
      if (cancelled) return;
      if (!window.turnstile) {
        window.setTimeout(tryRender, 200);
        return;
      }
      widgetId = window.turnstile.render(el, {
        sitekey: siteKey,
        theme: 'auto',
        callback: onToken,
        'expired-callback': () => onToken(''),
      });
    };
    tryRender();

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey, onToken]);

  return <div ref={ref} className="turnstile" />;
}
