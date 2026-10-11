import { useId, type ComponentType, type ReactNode } from 'react';
import { ChevronRight, ChevronsUpDown } from 'lucide-react';
import { SegmentedControl, Switch } from '@0xnullai/ui';

/**
 * The grouped list every 我的 page is built from: one rounded surface per group, rows with a
 * 20px icon, a 16px label and a chevron, and hairline dividers inset past the icon. A row's
 * own divider sits on its text column, so the last row needs no special case.
 */
export function SettingsGroup({
  label,
  footer,
  children,
}: {
  label?: string;
  /** One short note under the group, instead of text between controls. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      {label ? (
        <h3 className="px-4 text-[13px] font-medium text-[var(--text-faint)]">{label}</h3>
      ) : null}
      <div className="overflow-hidden rounded-2xl bg-[var(--bg-elevated)]">{children}</div>
      {footer ? <p className="px-4 text-xs leading-5 text-[var(--text-faint)]">{footer}</p> : null}
    </section>
  );
}

/** The vertical rhythm of every settings page. */
export function SettingsPage({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-6">{children}</div>;
}

/** The icon tile used by navigation rows: 32px rounded square, 18px line icon. */
export function IconTile({
  icon: Icon,
  tone = 'default',
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  tone?: 'default' | 'danger';
}) {
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] ${
        tone === 'danger'
          ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
          : 'bg-[var(--accent-soft)] text-[var(--accent)]'
      }`}
    >
      <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
    </span>
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
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
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
          <IconTile icon={Icon} tone={tone} />
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
          <span className="max-w-[45%] shrink-0 truncate whitespace-nowrap text-sm tabular-nums text-[var(--text-soft)]">
            {value}
          </span>
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

/** A row with a switch on the right. */
export function SwitchRow({
  label,
  detail,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  detail?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingsRow label={label} detail={detail}>
      <Switch
        label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </SettingsRow>
  );
}

/** A row with a segmented control on the right (four options at most). */
export function SegmentRow<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly (readonly [T, string])[];
}) {
  return (
    <SettingsRow label={label}>
      <SegmentedControl label={label} value={value} onChange={onChange} options={options} />
    </SettingsRow>
  );
}

/** A row whose value opens the platform picker; used for more than four options. */
export function SelectRow({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <SettingsRow label={<label htmlFor={id}>{label}</label>}>
      <span className="relative flex max-w-[60%] shrink-0 items-center">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          // Inline: the global form-field rule (border, fill, padding) is unlayered and would
          // otherwise win over utilities, turning the row value into a boxed field.
          style={{
            border: 'none',
            background: 'transparent',
            padding: '4px 20px 4px 0',
            boxShadow: 'none',
            width: 'auto',
            maxWidth: '100%',
          }}
          className="cursor-pointer appearance-none truncate text-right text-sm text-[var(--text-soft)] focus-visible:outline-none disabled:opacity-50"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronsUpDown
          aria-hidden
          className="pointer-events-none absolute right-0 h-3.5 w-3.5 text-[var(--text-faint)]"
        />
      </span>
    </SettingsRow>
  );
}

/** A numeric setting: label and value on one line, the slider underneath. */
export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  format,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2 border-b border-[var(--surface-border)] px-4 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="truncate text-base text-[var(--text)]">
          {label}
        </label>
        <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-[var(--text-soft)]">
          {format ? format(value) : `${value}${unit}`}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-[var(--accent)] disabled:opacity-50"
      />
    </div>
  );
}
