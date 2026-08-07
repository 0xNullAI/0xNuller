import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  anchorTop: number;
  anchorRight?: number;
  children: ReactNode;
}

export function Popover({ open, onOpenChange, title, anchorTop, anchorRight = 8, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    // Defer one tick so the click that opened us doesn't immediately close
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      className="fixed z-50 w-[min(360px,calc(100vw-16px))] rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-2xl"
      style={{ top: anchorTop, right: anchorRight }}
    >
      <div className="flex items-center justify-between border-b border-[var(--surface-border)] px-3 py-2">
        <p className="text-sm font-medium text-[var(--text)]">{title}</p>
        <button
          onClick={() => onOpenChange(false)}
          className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
          aria-label="关闭"
        >
          <X size={14} />
        </button>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}
