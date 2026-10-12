import { useTheme } from '@0xnullai/ui';
import { SegmentRow, SelectRow, SettingsGroup, SettingsPage } from './settings-list';
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
    <SettingsPage>
      <SettingsGroup label="外观">
        <SegmentRow
          label="主题"
          value={mode}
          onChange={setMode}
          options={THEMES.map((theme) => [theme.value, theme.label] as const)}
        />
        <SelectRow
          label="语言"
          value={locale}
          onChange={(value) => setLocale(updateLocale(value as AppLocale))}
          options={[
            { value: 'zh-CN', label: '中文' },
            { value: 'ja-JP', label: '日本語' },
          ]}
        />
      </SettingsGroup>
      <NotificationSettings accountId={accountId} />
    </SettingsPage>
  );
}
