import {
  isProviderId,
  migrateLegacyProviderSettings,
  type ProviderId,
} from '@0xnullai/llm-providers';
import type { PersistedProviderSettings } from './browser-settings-schema.js';

export type MigratedPersistedProvider = Omit<PersistedProviderSettings, 'providerId'> & {
  providerId: ProviderId;
};

export interface MigratedPersistedProviders {
  provider?: MigratedPersistedProvider;
  providerConfigs?: Partial<Record<ProviderId, MigratedPersistedProvider>>;
  /** The removed provider whose saved API key now belongs to `custom`. */
  customKeySource?: string;
}

function migrateOne(config: PersistedProviderSettings): MigratedPersistedProvider {
  const { apiKey: _apiKey, ...migrated } = migrateLegacyProviderSettings({
    ...config,
    // Agent keeps keys in a separate map; they are moved by `migrateApiKeys`.
    apiKey: '',
  });
  return migrated;
}

/**
 * Agent's own blob from before the provider reduction. Only the active provider is
 * carried into `custom` (with its key); inactive configs of removed providers are
 * dropped, since several of them would otherwise compete for the one custom slot.
 */
export function migratePersistedProviders(
  provider: PersistedProviderSettings | undefined,
  providerConfigs: Record<string, PersistedProviderSettings> | undefined,
): MigratedPersistedProviders {
  const configs: Partial<Record<ProviderId, MigratedPersistedProvider>> = {};
  for (const config of Object.values(providerConfigs ?? {})) {
    if (isProviderId(config.providerId)) configs[config.providerId] = migrateOne(config);
  }

  const active = provider ? migrateOne(provider) : undefined;
  if (active) configs[active.providerId] = active;
  const customKeySource =
    provider && !isProviderId(provider.providerId) && active?.providerId === 'custom'
      ? provider.providerId
      : undefined;

  return {
    ...(active ? { provider: active } : {}),
    ...(providerConfigs || active ? { providerConfigs: configs } : {}),
    ...(customKeySource ? { customKeySource } : {}),
  };
}

/** Keeps only current provider keys, moving the migrated provider's key to `custom`. */
export function migrateApiKeys(
  apiKeys: Readonly<Record<string, string | undefined>>,
  customKeySource: string | undefined,
): Partial<Record<ProviderId, string>> {
  const migrated: Partial<Record<ProviderId, string>> = {};
  if (apiKeys.managed) migrated.managed = apiKeys.managed;
  const custom = (customKeySource && apiKeys[customKeySource]) || apiKeys.custom;
  if (custom) migrated.custom = custom;
  return migrated;
}
