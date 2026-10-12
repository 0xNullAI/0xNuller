import { useEffect, useRef, useState, type RefObject } from 'react';

export type VisibleMessageRead = (id: string, stillVisible: () => boolean) => Promise<void>;
/** Only a retained server message actually intersecting the visible UI may be acknowledged. */
export function useVisibleMessageRead(
  messageId: string | undefined,
  elements: RefObject<Map<string, HTMLDivElement>>,
  acknowledge: VisibleMessageRead | undefined,
): string | null {
  const [error, setError] = useState<string | null>(null);
  const completed = useRef<string | null>(null);
  useEffect(() => {
    if (!messageId || !acknowledge || typeof IntersectionObserver === 'undefined') return;
    const element = elements.current.get(messageId);
    if (!element) return;
    completed.current = null;
    let active = true,
      intersecting = false,
      pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () =>
      active &&
      intersecting &&
      document.visibilityState === 'visible' &&
      element.isConnected &&
      element.getBoundingClientRect().height > 0 &&
      getComputedStyle(element).visibility !== 'hidden';
    const schedule = () => {
      clearTimeout(timer);
      if (!visible() || pending || completed.current === messageId) return;
      timer = setTimeout(() => {
        if (!visible()) return;
        pending = true;
        void acknowledge(messageId, visible)
          .then(() => {
            if (active) {
              completed.current = messageId;
              setError(null);
            }
          })
          .catch(() => {
            if (active) setError('已读状态尚未同步，可在收件箱重试。');
          })
          .finally(() => {
            pending = false;
          });
      }, 500);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        intersecting = entries.some(
          (entry) =>
            entry.target === element && entry.isIntersecting && entry.intersectionRatio >= 0.1,
        );
        schedule();
      },
      { threshold: 0.1 },
    );
    observer.observe(element);
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('focus', schedule);
    return () => {
      active = false;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('focus', schedule);
    };
  }, [messageId, elements, acknowledge]);
  return error;
}
