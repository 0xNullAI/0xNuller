import { useTheme } from '@0xnullai/ui';

const THEMES = [
  { value: 'auto', label: '跟随系统' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
] as const;

export function AppearanceTab() {
  const { mode, setMode } = useTheme();

  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="text-sm font-semibold">主题</h3>
        {/* Sized to its labels, not to the panel. `flex-1` inside a full-width
            row stretched three options across ~700px, which reads as three
            large buttons rather than one control with three states — and it
            was the last place still using the round-pill + solid-accent
            treatment that the other segmented controls moved off. */}
        <div className="mt-3 inline-flex rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-0.5 text-xs">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setMode(t.value)}
              aria-pressed={mode === t.value}
              className={
                'rounded-[var(--radius-xs)] px-3.5 py-1.5 transition-colors duration-[var(--dur)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ' +
                (mode === t.value
                  ? 'bg-[var(--accent-soft)] font-medium text-[var(--text)]'
                  : 'text-[var(--text-soft)] hover:text-[var(--text)]')
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
