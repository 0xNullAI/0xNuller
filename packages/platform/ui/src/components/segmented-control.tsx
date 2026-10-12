/**
 * One small set of mutually exclusive options (theme, type filters, memory kinds). Sized to
 * its labels, never stretched, and labels never wrap.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  disabled,
  className = '',
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly (readonly [T, string])[];
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex shrink-0 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-0.5 text-xs ${className}`}
    >
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          disabled={disabled}
          onClick={() => onChange(option)}
          className={`whitespace-nowrap rounded-[var(--radius-xs)] px-3 py-1.5 transition-colors duration-[var(--dur)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50 ${
            value === option
              ? 'bg-[var(--accent-soft)] font-medium text-[var(--text)]'
              : 'text-[var(--text-soft)] hover:text-[var(--text)]'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
