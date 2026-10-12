/** The one on/off control in settings. */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name; the visible label sits next to the switch. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-[22px] w-[40px] shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-[var(--dur-mid)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-strong)] disabled:opacity-50 ${
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--surface-border-strong)]'
      }`}
    >
      <span
        className={`pointer-events-none block h-[18px] w-[18px] rounded-full bg-white transition-transform duration-[var(--dur-mid)] ${
          checked ? 'translate-x-[18px]' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
