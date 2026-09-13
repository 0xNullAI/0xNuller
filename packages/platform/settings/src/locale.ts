import { readPreference, writePreference } from './preference-storage.js';

export type AppLocale = 'zh-CN' | 'ja-JP';

const KEY = '0xnullai.locale';

export function loadLocale(): AppLocale {
  return readPreference(KEY) === 'ja-JP' ? 'ja-JP' : 'zh-CN';
}

export function saveLocale(locale: AppLocale): AppLocale {
  writePreference(KEY, locale);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  return locale;
}

export function updateLocale(locale: AppLocale): AppLocale {
  return saveLocale(locale);
}
