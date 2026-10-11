import { SegmentedControl, SettingSelect, useTheme } from '@0xnullai/ui';
import { loadLocale, updateLocale, type AppLocale } from '@0xnullai/settings';
import { useEffect, useState } from 'react';
import { NotificationSettings } from './NotificationSettings';

const THEMES = [
  { value: 'auto', label: '跟随系统' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
] as const;

export function GeneralTab({ accountId }: { accountId: string | null }) {
  const { mode, setMode } = useTheme();
  const [locale, setLocale] = useState<AppLocale>(loadLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="text-sm font-semibold">主题</h3>
        <SegmentedControl
          label="主题"
          className="mt-3"
          value={mode}
          onChange={setMode}
          options={THEMES.map((theme) => [theme.value, theme.label] as const)}
        />
      </section>

      <section>
        <h3 className="text-sm font-semibold">语言</h3>
        <div className="mt-3">
          <SettingSelect
            value={locale}
            onValueChange={(value) => setLocale(updateLocale(value as AppLocale))}
            options={[
              { value: 'zh-CN', label: '中文' },
              { value: 'ja-JP', label: '日本語' },
            ]}
          />
        </div>
      </section>

      <NotificationSettings accountId={accountId} />
    </div>
  );
}
