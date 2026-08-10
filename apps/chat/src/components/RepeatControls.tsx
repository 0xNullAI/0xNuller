import { useCallback, useEffect, useRef, type ReactNode } from 'react';

/**
 * The press-and-hold strength controls, in one place.
 *
 * MemberControl and OpossumControl each carried their own copy of
 * `useRepeatAction` + `RepeatButton` (OpossumControl's even said so in a
 * comment: "implemented separately to keep OpossumControl self-contained").
 * Two copies that had already drifted — one refreshed its action ref during
 * render, the other in an effect — is exactly the shape that produces "we
 * fixed the hold-to-repeat bug, but only in one of the two panels". Control
 * needs the same controls, so this is the single copy all three import.
 */

const RING_R = 40;
const RING_C = 2 * Math.PI * RING_R;

const DEFAULT_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-xs text-[var(--text)] hover:border-[var(--accent)] active:scale-90';

/**
 * Fire `action` once on press, then repeat while held.
 *
 * The two drifted copies are reconciled on the render-time ref refresh, which
 * is the safer of the two: an effect updates the ref one commit late, so a
 * repeat tick can read a stale closure and send a device command computed from
 * a strength that is no longer current.
 */
export function useRepeatAction(action: () => void, initialDelay = 400, repeatInterval = 100) {
  const timerRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const actionRef = useRef(action);
  // Refreshing this "latest value" ref during render is deliberate: moving it into an effect
  // would make it update one commit late, so device commands could read a stale reference.
  // Leave it for a dedicated useEffectEvent refactor; don't change behavior in a structural merge.
  // eslint-disable-next-line react-hooks/refs
  actionRef.current = action;

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    stop();
    actionRef.current();
    timerRef.current = window.setTimeout(() => {
      intervalRef.current = window.setInterval(() => actionRef.current(), repeatInterval);
    }, initialDelay);
  }, [stop, initialDelay, repeatInterval]);

  useEffect(() => stop, [stop]);

  // A scroll, system gesture or app interruption can cancel a touch pointer
  // without producing pointerup. Stop there too, or the repeat interval keeps
  // issuing strength commands after the user's finger is no longer down.
  return { onPointerDown: start, onPointerUp: stop, onPointerLeave: stop, onPointerCancel: stop };
}

export function RepeatButton({
  onAction,
  className = DEFAULT_BUTTON_CLASS,
  disabled = false,
  children,
}: {
  onAction: () => void;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const handlers = useRepeatAction(onAction);
  return (
    <button
      {...handlers}
      disabled={disabled}
      onContextMenu={(e) => e.preventDefault()}
      className={className}
      style={{ touchAction: 'manipulation', WebkitUserSelect: 'none', userSelect: 'none' }}
    >
      {children}
    </button>
  );
}

/** Circular gauge reading "current value out of the cap that is actually enforced". */
export function IntensityRing({
  label,
  value,
  limit,
}: {
  label: string;
  value: number;
  limit: number;
}) {
  const pct = limit > 0 ? Math.min(1, value / limit) : 0;
  const offset = RING_C * (1 - pct);
  return (
    <div className="relative flex items-center justify-center" style={{ width: 96, height: 96 }}>
      <svg className="absolute inset-0" viewBox="0 0 96 96">
        <circle
          cx="48"
          cy="48"
          r={RING_R}
          fill="none"
          stroke="var(--surface-border)"
          strokeWidth="6"
        />
        <circle
          cx="48"
          cy="48"
          r={RING_R}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={offset}
          transform="rotate(-90 48 48)"
          className="transition-all duration-[var(--dur)]"
        />
      </svg>
      <div className="flex flex-col items-center">
        <span className="text-xl font-bold tabular-nums text-[var(--text)]">{value}</span>
        <span className="text-[10px] text-[var(--text-faint)]">
          {label}:{limit}
        </span>
      </div>
    </div>
  );
}
