/** Red count over a navigation icon; the button itself carries the accessible label. */
export function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden
      className="absolute -right-2.5 -top-1 min-w-[18px] rounded-full bg-[var(--danger)] px-1 text-center text-[11px] font-semibold leading-[18px] text-white ring-2 ring-[var(--bg-elevated)]"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
