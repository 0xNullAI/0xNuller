import { useEffect, useState } from 'react';
import { Input, SettingSelect } from '@0xnullai/ui';
import {
  PROVIDER_DEFINITIONS,
  defaultLlmConfig,
  getProviderDefinition,
  isLlmConfigured,
  loadLlmConfig,
  saveLlmConfig,
  subscribeLlmConfig,
  type LlmConfig,
  type ProviderId,
} from '@0xnullai/llm-providers';
import { VoiceProviderSection } from './VoiceProviderSection';
import { ProxySection } from './ProxySection';

/**
 * AI configuration. Text and voice both live here.
 *
 * Agent and Chat share this text config — before the merge each side stored its
 * own, so a user who configured it in one place had to configure it again in the
 * other. The voice one is a separate set of endpoints and auth (the realtime
 * protocol), so it is a sibling section rather than being mixed into the same group
 * of fields: forcing them into one group makes the two sides' required fields
 * pollute each other.
 *
 * The proxy also lives here: what it affects is exactly these model requests. **On
 * the web only an HTTP reverse proxy is viable** — browsers do not let a page pick
 * its own SOCKS proxy, that is an OS-level setting. Giving the web a SOCKS switch
 * means giving it a button that looks usable but can never take effect, so it is
 * disabled here based on the runtime, with the reason spelled out.
 */
export function AiTab() {
  const [config, setConfig] = useState<LlmConfig>(loadLlmConfig);

  useEffect(() => subscribeLlmConfig(setConfig), []);

  function update(patch: Partial<LlmConfig>) {
    const next = { ...config, ...patch };
    setConfig(next);
    saveLlmConfig(next);
  }

  const def = getProviderDefinition(config.providerId as ProviderId);
  const isFree = config.providerId === 'free';

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
        <h3 className="text-sm font-semibold">文本模型</h3>
        <div className="mt-3">
          <SettingSelect
            value={config.providerId}
            onValueChange={(value) => {
              const next = defaultLlmConfig();
              // Don't keep the previous provider's key and baseUrl when switching — they are
              // meaningless on the new service, and keeping them only makes "why is auth
              // failing" hard to track down.
              update({ ...next, providerId: value });
            }}
            // free is already in PROVIDER_DEFINITIONS; do not add a second entry by hand —
            // when the same value appears twice, Radix renders both labels into the trigger,
            // showing 「免费体验免费体验」.
            options={PROVIDER_DEFINITIONS.filter((p) => p.browserSupported).map((p) => ({
              value: p.id,
              label: p.name,
            }))}
          />
        </div>

        {!isFree && (
          <div className="mt-3 flex flex-col gap-3">
            {def?.fields
              .filter((field) => field.key !== 'model')
              .map((field) => (
                <label key={field.key} className="flex flex-col gap-1.5">
                  <span className="text-xs text-[var(--text-soft)]">{field.label}</span>
                  <Input
                    type={field.key === 'apiKey' ? 'password' : 'text'}
                    value={(config[field.key as keyof LlmConfig] as string) ?? ''}
                    placeholder={field.placeholder}
                    onChange={(e) => update({ [field.key]: e.target.value } as Partial<LlmConfig>)}
                  />
                </label>
              ))}
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-[var(--text-soft)]">模型</span>
              <Input
                value={config.model}
                onChange={(e) => update({ model: e.target.value })}
                placeholder="留空使用默认模型"
              />
            </label>
          </div>
        )}

        {!isLlmConfigured(config) && (
          <p className="mt-3 text-xs text-[var(--danger)]">配置未完成</p>
        )}
      </section>

      <VoiceProviderSection />
      <ProxySection />
    </div>
  );
}
