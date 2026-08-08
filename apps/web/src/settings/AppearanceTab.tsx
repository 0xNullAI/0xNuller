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
        <p className="mt-1 text-xs text-[var(--text-faint)]">
          只影响这台设备上的显示。所有模块共用同一个值。
        </p>
        <div className="mt-3 flex rounded-full bg-[var(--bg-strong)] p-0.5 text-xs">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setMode(t.value)}
              className={
                'flex-1 rounded-full px-3.5 py-1.5 font-medium transition-all ' +
                (mode === t.value
                  ? 'bg-[var(--accent)] text-[var(--button-text)]'
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
