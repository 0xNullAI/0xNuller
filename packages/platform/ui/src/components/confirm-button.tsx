import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';

/**
 * A button for an action that cannot be undone. The first press arms it and changes its label;
 * a second press within a few seconds runs it. No native confirm dialog: that would block the
 * page, including the stop button, while a device may be connected.
 */
export function ConfirmButton({
  onConfirm,
  confirmLabel,
  children,
  armedClassName,
  className,
  timeoutMs = 4000,
  ...props
}: Omit<ComponentProps<'button'>, 'onClick'> & {
  onConfirm: () => void;
  confirmLabel: ReactNode;
  armedClassName?: string;
  timeoutMs?: number;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), timeoutMs);
    return () => clearTimeout(timer);
  }, [armed, timeoutMs]);
  return (
    <button
      type="button"
      {...props}
      className={armed && armedClassName ? `${className ?? ''} ${armedClassName}` : className}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
