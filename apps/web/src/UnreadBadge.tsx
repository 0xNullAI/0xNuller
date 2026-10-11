/** Red count over a navigation icon; the button itself carries the accessible label. */
export function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden
      className="absolute -right-2.5 -top-1.5 min-w-[18px] rounded-full bg-[var(--danger,#e5484d)] px-1 text-center text-[10px] font-semibold leading-[18px] text-white"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
