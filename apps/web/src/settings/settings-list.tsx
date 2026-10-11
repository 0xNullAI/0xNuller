import type { ComponentType, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * The grouped list every 我的 page is built from: one rounded surface per group, rows with a
 * 20px icon, a 16px label and a chevron, and hairline dividers inset past the icon. A row's
 * own divider sits on its text column, so the last row needs no special case.
 */
export function SettingsGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {label ? (
        <h3 className="px-4 text-[13px] font-medium text-[var(--text-faint)]">{label}</h3>
      ) : null}
      <div className="overflow-hidden rounded-2xl bg-[var(--bg-elevated)]">{children}</div>
    </div>
  );
}

const ROW = 'group/row flex min-h-[52px] w-full items-stretch gap-3 pl-4 text-left';
const PRESSABLE =
  'transition-colors duration-150 motion-reduce:transition-none hover:bg-[var(--bg-soft)] active:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]';
const BODY =
  'flex min-w-0 flex-1 items-center gap-3 border-b border-[var(--surface-border)] py-3 pr-4 group-last/row:border-b-0';

export function SettingsRow({
  icon: Icon,
  label,
  detail,
  value,
  onClick,
  chevron = Boolean(onClick),
  tone = 'default',
  children,
}: {
  icon?: ComponentType<{ className?: string }>;
  label: ReactNode;
  /** One short faint line under the label. */
  detail?: ReactNode;
  /** Right-aligned value, before the chevron. */
  value?: ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  tone?: 'default' | 'danger';
  /** Trailing control for a row that is not itself a button. */
  children?: ReactNode;
}) {
  const body = (
    <>
      {Icon ? (
        <span className="flex shrink-0 items-center">
          <Icon className="h-5 w-5 text-[var(--accent)]" />
        </span>
      ) : null}
      <span className={BODY}>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-base ${tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--text)]'}`}
          >
            {label}
          </span>
          {detail ? (
            <span className="block truncate text-[13px] text-[var(--text-faint)]">{detail}</span>
          ) : null}
        </span>
        {value !== undefined ? (
          <span className="shrink-0 text-sm tabular-nums text-[var(--text-soft)]">{value}</span>
        ) : null}
        {children}
        {chevron ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-faint)]" aria-hidden />
        ) : null}
      </span>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={`${ROW} ${PRESSABLE}`}>
      {body}
    </button>
  ) : (
    <div className={ROW}>{body}</div>
  );
}
