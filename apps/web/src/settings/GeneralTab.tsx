import { useTheme } from '@0xnullai/ui';
import { loadLocale, updateLocale, type AppLocale } from '@0xnullai/settings';
import { useEffect, useState } from 'react';
import { ProxySection } from './ProxySection';

const THEMES = [
  { value: 'auto', label: '跟随系统' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
] as const;

export function GeneralTab() {
  const { mode, setMode } = useTheme();
  const [locale, setLocale] = useState<AppLocale>(loadLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

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

      <ProxySection />

      <section>
        <h3 className="text-sm font-semibold">语言</h3>
        <select
          value={locale}
          onChange={(event) => setLocale(updateLocale(event.target.value as AppLocale))}
          className="mt-3 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm"
        >
          <option value="zh-CN">中文</option>
          <option value="ja-JP">日本語</option>
        </select>
      </section>
    </div>
  );
}
