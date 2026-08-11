import { useEffect, useMemo, useState, type CSSProperties } from 'react';
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
import { BrowserAppSettingsStore, type ModelBehaviorSettings } from '@dg-agent/storage-browser';

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
  const behaviorStore = useMemo(() => new BrowserAppSettingsStore(), []);
  const [behavior, setBehavior] = useState<ModelBehaviorSettings>(() =>
    behaviorStore.loadModelBehavior(),
  );

  useEffect(() => subscribeLlmConfig(setConfig), []);
  useEffect(() => behaviorStore.subscribeModelBehavior(setBehavior), [behaviorStore]);

  function update(patch: Partial<LlmConfig>) {
    const next = { ...config, ...patch };
    setConfig(next);
    saveLlmConfig(next);
  }

  function updateBehavior(patch: Partial<ModelBehaviorSettings>) {
    setBehavior((current) => behaviorStore.saveModelBehavior({ ...current, ...patch }));
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
        <div className="mt-5 border-t border-[var(--surface-border)] pt-4">
          <h4 className="text-sm font-semibold">上下文与回复</h4>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-faint)]">
            仅影响 Agent，保存在当前设备，不随账户同步。修改后下一条消息起生效。
          </p>
          <div className="mt-3 grid gap-4">
            <label className="grid gap-1.5">
              <span className="text-xs text-[var(--text-soft)]">上下文策略</span>
              <SettingSelect
                value={behavior.modelContextStrategy}
                onValueChange={(value) =>
                  updateBehavior({
                    modelContextStrategy: value as ModelBehaviorSettings['modelContextStrategy'],
                  })
                }
                options={[
                  { value: 'last-user-turn', label: '基础（最近 1 轮）' },
                  { value: 'last-five-user-turns', label: '中等（最近 5 轮）' },
                  { value: 'full-history', label: '完整对话' },
                ]}
              />
            </label>
            <label className="grid gap-2">
              <span className="flex items-center justify-between text-xs text-[var(--text-soft)]">
                <span>回复多样性</span>
                <output className="font-mono tabular-nums">
                  {behavior.temperature.toFixed(2)}
                </output>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={behavior.temperature}
                aria-label="回复多样性"
                onChange={(event) => updateBehavior({ temperature: Number(event.target.value) })}
                className="w-full accent-[var(--accent)]"
                style={{ '--strength-value': `${behavior.temperature * 100}%` } as CSSProperties}
              />
              <span className="text-[11px] text-[var(--text-faint)]">
                越低越稳定，越高越有变化；设备控制仍受安全策略约束。
              </span>
            </label>
          </div>
        </div>
      </section>

      <VoiceProviderSection />
      <ProxySection />
    </div>
  );
}
