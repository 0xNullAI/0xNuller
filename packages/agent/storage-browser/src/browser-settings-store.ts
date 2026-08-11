import { loadDeviceSafety, saveDeviceSafety } from '@0xnullai/settings';
import {
  createProviderSettings,
  hasLlmConfig,
  loadLlmConfig,
  normalizeProviderSettings,
  type ProviderId,
} from '@0xnullai/llm-providers';
import type {
  BrowserAppSettings,
  BrowserAppEnvLike,
  ProviderConfigMap,
  StorageLike,
} from './browser-settings-types.js';
import type { ModelContextStrategy } from '@dg-agent/core';
import {
  API_KEYS_LOCAL,
  API_KEYS_SESSION,
  SETTINGS_KEY,
  TIMED_PERMISSION_WINDOW_MS,
  VOICE_API_KEY_LOCAL,
  VOICE_API_KEY_SESSION,
} from './browser-settings-constants.js';
import { defaultBrowserAppSettings, normalizeVoiceSettings } from './browser-settings-defaults.js';
import { settingsSchema, type PersistedBrowserAppSettings } from './browser-settings-schema.js';

export interface BrowserAppSettingsStoreOptions {
  localStorageRef?: StorageLike;
  sessionStorageRef?: StorageLike;
  env?: BrowserAppEnvLike;
}

export interface ModelBehaviorSettings {
  modelContextStrategy: ModelContextStrategy;
  temperature: number;
}

const MODEL_BEHAVIOR_CHANGED_EVENT = '0xnullai:agent-model-behavior-changed';

export class BrowserAppSettingsStore {
  private readonly localStorageRef: StorageLike | undefined;
  private readonly sessionStorageRef: StorageLike | undefined;
  private readonly defaults: BrowserAppSettings;
  private sessionPermissionModeOverride: BrowserAppSettings['permissionMode'] | null = null;
  private runtimeApiKeys: Partial<Record<ProviderId, string>> = {};
  private runtimeVoiceApiKey = '';

  constructor(options: BrowserAppSettingsStoreOptions = {}) {
    this.localStorageRef =
      options.localStorageRef ??
      (typeof localStorage === 'undefined' ? undefined : (localStorage as unknown as StorageLike));
    this.sessionStorageRef =
      options.sessionStorageRef ??
      (typeof sessionStorage === 'undefined'
        ? undefined
        : (sessionStorage as unknown as StorageLike));
    this.defaults = defaultBrowserAppSettings(options.env);
  }

  load(): BrowserAppSettings {
    const persisted = this.normalizePersistedSettings(this.readPersistedSettings());
    // The source of truth for device safety settings is @0xnullai/settings, one
    // copy shared by the whole app — if the user lowers the cap to 30 in Agent,
    // switching to Chat / Voice must not put it back at 50. This just spreads it
    // into this module's settings view.
    const safety = loadDeviceSafety();
    // Same story for the model provider: @0xnullai/llm-providers holds the one
    // copy, and the unified settings panel is what writes it. Agent used to
    // read only its own key, so the panel's line "Agent 与 Chat 共用这一份配置"
    // was simply untrue — and since Agent's provider UI moved into that panel,
    // there was no longer any way to configure Agent at all.
    // Only when the user has actually chosen one: loadLlmConfig always returns
    // something, so an untouched store would overwrite Agent's own provider
    // with the default.
    const llm = hasLlmConfig() ? loadLlmConfig() : null;
    const activeProviderId =
      (llm?.providerId as ProviderId | undefined) ??
      persisted?.provider?.providerId ??
      this.defaults.provider.providerId;
    const apiKeys = this.readApiKeys(activeProviderId);
    const voiceApiKey = this.readVoiceApiKey();
    const providerConfigs = this.buildProviderConfigs(persisted, apiKeys);
    // The shared config wins field by field, but only where it actually has a
    // value: a user who never opened the panel keeps whatever Agent persisted.
    const activeProvider = normalizeProviderSettings({
      ...createProviderSettings(activeProviderId),
      ...(providerConfigs[activeProviderId] ?? {}),
      ...(llm?.apiKey ? { apiKey: llm.apiKey } : {}),
      ...(llm?.model ? { model: llm.model } : {}),
      ...(llm?.baseUrl ? { baseUrl: llm.baseUrl } : {}),
    });
    providerConfigs[activeProviderId] = activeProvider;
    const effectivePermissionState = this.resolvePermissionState(persisted);

    return {
      ...this.defaults,
      ...persisted,
      // The shared safety settings override whatever this module used to
      // persist (after the migration the old fields are no longer written).
      maxStrengthA: safety.maxStrengthA,
      maxStrengthB: safety.maxStrengthB,
      maxColdStartStrength: safety.maxColdStartStrength,
      maxAdjustStrengthStep: safety.maxAdjustStep,
      maxBurstDurationMs: safety.maxBurstDurationMs,
      maxBurstStrengthAbsolute: safety.maxBurstStrengthAbsolute,
      maxBurstStrengthRelative: safety.maxBurstStrengthRelative,
      burstRequiresActiveChannel: safety.burstRequiresActiveChannel,
      maxOpossumIntensityA: safety.maxIntensityA,
      maxOpossumIntensityB: safety.maxIntensityB,
      maxOpossumColdStartIntensity: safety.maxColdStartIntensity,
      maxOpossumAdjustStep: safety.maxOpossumAdjustStep,
      maxToolIterations: safety.maxToolIterations,
      maxToolCallsPerTurn: safety.maxToolCallsPerTurn,
      maxAdjustStrengthCallsPerTurn: safety.maxAdjustStrengthCallsPerTurn,
      maxBurstCallsPerTurn: safety.maxBurstCallsPerTurn,
      maxVibrateAdjustCallsPerTurn: safety.maxVibrateAdjustCallsPerTurn,
      maxVibrateBurstCallsPerTurn: safety.maxVibrateBurstCallsPerTurn,
      permissionMode: effectivePermissionState.permissionMode,
      permissionModeExpiresAt: effectivePermissionState.permissionModeExpiresAt,
      bridge: {
        ...this.defaults.bridge,
        ...(persisted?.bridge ?? {}),
        qq: {
          ...this.defaults.bridge.qq,
          ...(persisted?.bridge?.qq ?? {}),
        },
        telegram: {
          ...this.defaults.bridge.telegram,
          ...(persisted?.bridge?.telegram ?? {}),
        },
      },
      provider: activeProvider,
      providerConfigs,
      voice: normalizeVoiceSettings({
        ...this.defaults.voice,
        ...(persisted?.voice ?? {}),
        apiKey: voiceApiKey,
      }),
    };
  }

  loadModelBehavior(): ModelBehaviorSettings {
    const settings = this.load();
    return {
      modelContextStrategy: settings.modelContextStrategy,
      temperature: settings.temperature,
    };
  }

  /**
   * Persist only Agent model behavior. This deliberately bypasses `save()`:
   * the unified AI panel must not rewrite safety/provider/API-key state from a
   * stale full-settings snapshot merely because a temperature slider moved.
   * These preferences are device-local and are not part of account sync.
   */
  saveModelBehavior(next: ModelBehaviorSettings): ModelBehaviorSettings {
    const persisted = this.readPersistedSettings() ?? { version: 1 as const };
    const normalized: ModelBehaviorSettings = {
      modelContextStrategy: next.modelContextStrategy,
      temperature: Math.min(1, Math.max(0, next.temperature)),
    };
    this.localStorageRef?.setItem(SETTINGS_KEY, JSON.stringify({ ...persisted, ...normalized }));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(MODEL_BEHAVIOR_CHANGED_EVENT, { detail: normalized }));
    }
    return normalized;
  }

  subscribeModelBehavior(listener: (settings: ModelBehaviorSettings) => void): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const onChanged = (event: Event) => {
      listener((event as CustomEvent<ModelBehaviorSettings>).detail ?? this.loadModelBehavior());
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === SETTINGS_KEY) listener(this.loadModelBehavior());
    };
    window.addEventListener(MODEL_BEHAVIOR_CHANGED_EVENT, onChanged);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(MODEL_BEHAVIOR_CHANGED_EVENT, onChanged);
      window.removeEventListener('storage', onStorage);
    };
  }

  save(settings: BrowserAppSettings): BrowserAppSettings {
    const providerConfigs = {
      ...settings.providerConfigs,
      [settings.provider.providerId]: settings.provider,
    };
    const persistedPermissionMode =
      settings.permissionMode === 'allow-all' ? 'confirm' : settings.permissionMode;
    const persistedPermissionModeExpiresAt =
      settings.permissionMode === 'timed' ? Date.now() + TIMED_PERMISSION_WINDOW_MS : undefined;

    this.sessionPermissionModeOverride =
      settings.permissionMode === 'allow-all' ? 'allow-all' : null;

    // Safety settings are written back to the shared source of truth, no longer
    // into this module's blob.
    saveDeviceSafety({
      maxStrengthA: settings.maxStrengthA,
      maxStrengthB: settings.maxStrengthB,
      maxColdStartStrength: settings.maxColdStartStrength,
      maxAdjustStep: settings.maxAdjustStrengthStep,
      maxBurstDurationMs: settings.maxBurstDurationMs,
      maxBurstStrengthAbsolute: settings.maxBurstStrengthAbsolute,
      maxBurstStrengthRelative: settings.maxBurstStrengthRelative,
      burstRequiresActiveChannel: settings.burstRequiresActiveChannel,
      maxIntensityA: settings.maxOpossumIntensityA,
      maxIntensityB: settings.maxOpossumIntensityB,
      maxColdStartIntensity: settings.maxOpossumColdStartIntensity,
      maxOpossumAdjustStep: settings.maxOpossumAdjustStep,
      maxToolIterations: settings.maxToolIterations,
      maxToolCallsPerTurn: settings.maxToolCallsPerTurn,
      maxAdjustStrengthCallsPerTurn: settings.maxAdjustStrengthCallsPerTurn,
      maxBurstCallsPerTurn: settings.maxBurstCallsPerTurn,
      maxVibrateAdjustCallsPerTurn: settings.maxVibrateAdjustCallsPerTurn,
      maxVibrateBurstCallsPerTurn: settings.maxVibrateBurstCallsPerTurn,
      permissionMode: persistedPermissionMode,
      permissionModeExpiresAt: persistedPermissionModeExpiresAt,
    });

    const sanitized = {
      version: 1 as const,
      showSafetyNoticeOnStartup: settings.showSafetyNoticeOnStartup,
      deviceMode: settings.deviceMode,
      llmMode: settings.llmMode,
      modelContextStrategy: settings.modelContextStrategy,
      temperature: settings.temperature,
      permissionMode: persistedPermissionMode,
      permissionModeExpiresAt: persistedPermissionModeExpiresAt,
      maxStrengthA: settings.maxStrengthA,
      maxStrengthB: settings.maxStrengthB,
      maxColdStartStrength: settings.maxColdStartStrength,
      maxToolIterations: settings.maxToolIterations,
      maxToolCallsPerTurn: settings.maxToolCallsPerTurn,
      maxAdjustStrengthCallsPerTurn: settings.maxAdjustStrengthCallsPerTurn,
      maxAdjustStrengthStep: settings.maxAdjustStrengthStep,
      maxBurstCallsPerTurn: settings.maxBurstCallsPerTurn,
      maxBurstDurationMs: settings.maxBurstDurationMs,
      maxBurstStrengthAbsolute: settings.maxBurstStrengthAbsolute,
      maxBurstStrengthRelative: settings.maxBurstStrengthRelative,
      burstRequiresActiveChannel: settings.burstRequiresActiveChannel,
      maxOpossumIntensityA: settings.maxOpossumIntensityA,
      maxOpossumIntensityB: settings.maxOpossumIntensityB,
      maxOpossumColdStartIntensity: settings.maxOpossumColdStartIntensity,
      maxOpossumAdjustStep: settings.maxOpossumAdjustStep,
      maxVibrateAdjustCallsPerTurn: settings.maxVibrateAdjustCallsPerTurn,
      maxVibrateBurstCallsPerTurn: settings.maxVibrateBurstCallsPerTurn,
      civetPressureDeltaThresholdKPa: settings.civetPressureDeltaThresholdKPa,
      sensorTriggerDebounceMs: settings.sensorTriggerDebounceMs,
      safetyStopOnLeave: settings.safetyStopOnLeave,
      rememberApiKey: settings.rememberApiKey,
      modelLogEnabled: settings.modelLogEnabled,
      speechRecognitionEnabled: settings.speechRecognitionEnabled,
      speechSynthesisEnabled: settings.speechSynthesisEnabled,
      speechRecognitionLanguage: settings.speechRecognitionLanguage,
      speechSynthesisLanguage: settings.speechSynthesisLanguage,
      bridge: settings.bridge,
      provider: {
        providerId: settings.provider.providerId,
        baseUrl: settings.provider.baseUrl,
        model: settings.provider.model,
        endpoint: settings.provider.endpoint,
        useStrict: settings.provider.useStrict,
      },
      providerConfigs: Object.fromEntries(
        Object.entries(providerConfigs).map(([providerId, provider]) => [
          providerId,
          {
            providerId: provider.providerId,
            baseUrl: provider.baseUrl,
            model: provider.model,
            endpoint: provider.endpoint,
            useStrict: provider.useStrict,
          },
        ]),
      ),
      voice: {
        mode: settings.voice.mode,
        speaker: settings.voice.speaker,
        browserVoiceUri: settings.voice.browserVoiceUri,
        proxyUrl: settings.voice.proxyUrl,
        autoStopEnabled: settings.voice.autoStopEnabled,
      },
    };

    this.localStorageRef?.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(MODEL_BEHAVIOR_CHANGED_EVENT, {
          detail: {
            modelContextStrategy: sanitized.modelContextStrategy,
            temperature: sanitized.temperature,
          } satisfies ModelBehaviorSettings,
        }),
      );
    }
    this.persistApiKeys(providerConfigs, settings.rememberApiKey);
    this.persistVoiceApiKey(settings.voice.apiKey, settings.rememberApiKey);
    return this.load();
  }

  reset(): BrowserAppSettings {
    this.sessionPermissionModeOverride = null;
    this.runtimeApiKeys = {};
    this.runtimeVoiceApiKey = '';
    this.localStorageRef?.removeItem(SETTINGS_KEY);
    this.localStorageRef?.removeItem(API_KEYS_LOCAL);
    this.localStorageRef?.removeItem(VOICE_API_KEY_LOCAL);
    this.sessionStorageRef?.removeItem(API_KEYS_SESSION);
    this.sessionStorageRef?.removeItem(VOICE_API_KEY_SESSION);
    return this.defaults;
  }

  clearSessionPermissionModeOverride(): BrowserAppSettings {
    this.sessionPermissionModeOverride = null;
    return this.load();
  }

  private readPersistedSettings(): PersistedBrowserAppSettings | null {
    const raw = this.localStorageRef?.getItem(SETTINGS_KEY);
    if (!raw) return null;

    try {
      return settingsSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private normalizePersistedSettings(
    persisted: PersistedBrowserAppSettings | null,
  ): PersistedBrowserAppSettings | null {
    if (!persisted) return null;

    // 6.0 accidentally shipped the terse/samey pair as persisted defaults.
    // Migrate only that exact pair; any other combination reflects a user choice.
    const legacyConversationDefaults =
      persisted.modelContextStrategy === 'last-user-turn' && persisted.temperature === 0.3;

    return {
      ...persisted,
      ...(legacyConversationDefaults
        ? { modelContextStrategy: 'last-five-user-turns' as const, temperature: 0.7 }
        : {}),
      deviceMode: persisted.deviceMode === 'fake' ? 'web-bluetooth' : persisted.deviceMode,
      llmMode: persisted.llmMode === 'fake' ? 'provider-http' : persisted.llmMode,
      speechRecognitionEnabled: persisted.speechRecognitionEnabled ?? persisted.voiceInputEnabled,
      speechSynthesisEnabled: persisted.speechSynthesisEnabled ?? persisted.ttsEnabled,
      speechRecognitionLanguage:
        persisted.speechRecognitionLanguage ?? persisted.speechLanguage ?? persisted.voiceLanguage,
      speechSynthesisLanguage:
        persisted.speechSynthesisLanguage ?? persisted.speechLanguage ?? persisted.voiceLanguage,
    };
  }

  private buildProviderConfigs(
    persisted: PersistedBrowserAppSettings | null,
    apiKeys: Partial<Record<ProviderId, string>>,
  ): ProviderConfigMap {
    const providerConfigs: ProviderConfigMap = {
      ...this.defaults.providerConfigs,
    };

    const persistedConfigs = persisted?.providerConfigs ?? {};
    for (const config of Object.values(persistedConfigs)) {
      providerConfigs[config.providerId] = normalizeProviderSettings({
        ...createProviderSettings(config.providerId),
        ...config,
        apiKey: apiKeys[config.providerId] ?? '',
      });
    }

    if (persisted?.provider) {
      providerConfigs[persisted.provider.providerId] = normalizeProviderSettings({
        ...createProviderSettings(persisted.provider.providerId),
        ...persisted.provider,
        apiKey: apiKeys[persisted.provider.providerId] ?? '',
      });
    }

    for (const [providerId, apiKey] of Object.entries(apiKeys)) {
      if (!apiKey) continue;
      const typedProviderId = providerId as ProviderId;
      providerConfigs[typedProviderId] = normalizeProviderSettings({
        ...(providerConfigs[typedProviderId] ?? createProviderSettings(typedProviderId)),
        apiKey,
      });
    }

    return providerConfigs;
  }

  private readApiKeys(activeProviderId: ProviderId): Partial<Record<ProviderId, string>> {
    if (Object.keys(this.runtimeApiKeys).length > 0) return this.runtimeApiKeys;

    return this.parseApiKeyMap(this.localStorageRef?.getItem(API_KEYS_LOCAL), activeProviderId);
  }

  private persistApiKeys(providerConfigs: ProviderConfigMap, remember: boolean): void {
    const apiKeys = Object.fromEntries(
      Object.entries(providerConfigs)
        .map(([providerId, provider]) => [providerId, provider.apiKey.trim()])
        .filter(([, apiKey]) => Boolean(apiKey)),
    );

    if (remember) {
      this.runtimeApiKeys = {};
      if (Object.keys(apiKeys).length > 0) {
        this.localStorageRef?.setItem(API_KEYS_LOCAL, JSON.stringify(apiKeys));
      } else {
        this.localStorageRef?.removeItem(API_KEYS_LOCAL);
      }
      this.sessionStorageRef?.removeItem(API_KEYS_SESSION);
      return;
    }

    this.runtimeApiKeys = apiKeys;
    this.localStorageRef?.removeItem(API_KEYS_LOCAL);
    this.sessionStorageRef?.removeItem(API_KEYS_SESSION);
  }

  private readVoiceApiKey(): string {
    if (this.runtimeVoiceApiKey) return this.runtimeVoiceApiKey;

    return this.localStorageRef?.getItem(VOICE_API_KEY_LOCAL) ?? this.defaults.voice.apiKey;
  }

  private persistVoiceApiKey(apiKey: string, remember: boolean): void {
    const trimmedApiKey = apiKey.trim();

    if (remember) {
      this.runtimeVoiceApiKey = '';
      if (trimmedApiKey) {
        this.localStorageRef?.setItem(VOICE_API_KEY_LOCAL, trimmedApiKey);
      } else {
        this.localStorageRef?.removeItem(VOICE_API_KEY_LOCAL);
      }
      this.sessionStorageRef?.removeItem(VOICE_API_KEY_SESSION);
      return;
    }

    this.runtimeVoiceApiKey = trimmedApiKey;
    this.localStorageRef?.removeItem(VOICE_API_KEY_LOCAL);
    this.sessionStorageRef?.removeItem(VOICE_API_KEY_SESSION);
  }

  private parseApiKeyMap(
    raw: string | null | undefined,
    fallbackProviderId: ProviderId,
  ): Partial<Record<ProviderId, string>> {
    if (!raw) return {};

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed).filter(
          (entry): entry is [ProviderId, string] => typeof entry[1] === 'string',
        );
        return Object.fromEntries(entries);
      }
    } catch {
      return raw ? { [fallbackProviderId]: raw } : {};
    }

    return {};
  }

  private resolvePermissionState(
    persisted: PersistedBrowserAppSettings | null,
  ): Pick<BrowserAppSettings, 'permissionMode' | 'permissionModeExpiresAt'> {
    if (this.sessionPermissionModeOverride === 'allow-all') {
      return {
        permissionMode: 'allow-all',
        permissionModeExpiresAt: undefined,
      };
    }

    const persistedMode = persisted?.permissionMode ?? this.defaults.permissionMode;
    const persistedExpiry = persisted?.permissionModeExpiresAt;

    if (persistedMode === 'allow-all') {
      return {
        permissionMode: 'confirm',
        permissionModeExpiresAt: undefined,
      };
    }

    if (persistedMode === 'timed') {
      if (typeof persistedExpiry === 'number' && Date.now() < persistedExpiry) {
        return {
          permissionMode: 'timed',
          permissionModeExpiresAt: persistedExpiry,
        };
      }

      return {
        permissionMode: 'confirm',
        permissionModeExpiresAt: undefined,
      };
    }

    return {
      permissionMode: 'confirm',
      permissionModeExpiresAt: undefined,
    };
  }
}
