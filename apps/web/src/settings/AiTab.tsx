import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Button, Input, SettingSelect } from '@0xnullai/ui';
import {
  createProviderSettings,
  getBrowserProviderDefinitions,
  getProviderDefinition,
  getProviderRegion,
  isLlmConfigured,
  loadLlmConfig,
  MANAGED_MODEL_OPTIONS,
  saveLlmConfig,
  subscribeLlmConfig,
  type LlmConfig,
  type ProviderId,
} from '@0xnullai/llm-providers';
import { VoiceTimbreField } from './VoiceTimbreField';
import { VideoProviderSection } from './VideoProviderSection';
import { BrowserAppSettingsStore, type ModelBehaviorSettings } from '@dg-agent/storage-browser';
import {
  discoverBrowserProviderModels,
  testBrowserProviderConnection,
} from '@dg-agent/agent-browser/llm';
import type { PiAiModelInfo } from '@dg-agent/providers-pi-http';
import { ProviderCredentialFields, ProviderRememberApiKey } from './ProviderCredentialFields';
import { AdvancedEntryRow, AdvancedSection, AdvancedSubpage } from './SettingsAdvanced';
import { ModelCombobox, useRecommendedModel } from './ModelCombobox';

/**
 * AI configuration. Agent, Voice and Video are configured here but keep separate stores.
 *
 * The page shows only the model tier and the voice. Everything else (own API, context,
 * Video) sits on one flat 高级 sub-page. Agent and Chat share the text config; Video
 * (image-input allowlist, never copies Agent credentials) stays a separate section so
 * their required fields do not mix. Realtime voice is managed-only: its one setting
 * is the voice on the main page.
 */
export type AiSettingsSection = 'video';

const PROVIDER_REGION_LABEL = {
  mainland: '中国大陆',
  international: '国际',
  custom: '自定义',
} as const;

export function AiTab({ initialSection }: { initialSection?: AiSettingsSection }) {
  const [advanced, setAdvanced] = useState(initialSection !== undefined);
  const [config, setConfig] = useState<LlmConfig>(loadLlmConfig);
  const closeAdvanced = useCallback(() => setAdvanced(false), []);

  useEffect(() => subscribeLlmConfig(setConfig), []);
  useEffect(() => {
    if (initialSection) document.getElementById(`ai-${initialSection}`)?.scrollIntoView?.();
  }, [initialSection]);

  function update(patch: Partial<LlmConfig>) {
    const next = { ...config, ...patch };
    setConfig(next);
    saveLlmConfig(next);
  }

  function switchToManaged() {
    update({ ...createProviderSettings('managed'), rememberApiKey: config.rememberApiKey });
  }

  if (advanced)
    return (
      <AdvancedSubpage title="AI · 高级" onBack={closeAdvanced}>
        <OwnApiSection config={config} update={update} onUseManaged={switchToManaged} />
        <BehaviorSection />
        <AdvancedSection id="ai-video" title="Video 视觉模型">
          <VideoProviderSection />
        </AdvancedSection>
      </AdvancedSubpage>
    );

  const def = getProviderDefinition(config.providerId as ProviderId);
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Agent 模型" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">模型档位</h3>
        {config.providerId === 'managed' ? (
          <>
            <SettingSelect
              value={config.model}
              onValueChange={(model) => update({ model })}
              options={MANAGED_MODEL_OPTIONS.map((option) => ({
                value: option.id,
                label: option.name,
              }))}
            />
            <p className="text-xs text-[var(--text-faint)]">登录后按用量消耗 Credit。</p>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-soft)]">
            <span>正在使用自己的 API：{def?.name ?? config.providerId}</span>
            <button
              type="button"
              className="text-[var(--accent)] hover:underline"
              onClick={switchToManaged}
            >
              切换回猫愿模型
            </button>
          </div>
        )}
      </section>
      <section aria-label="语音" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">语音</h3>
        <VoiceTimbreField />
      </section>
      <AdvancedEntryRow onOpen={() => setAdvanced(true)} />
    </div>
  );
}

function OwnApiSection({
  config,
  update,
  onUseManaged,
}: {
  config: LlmConfig;
  update: (patch: Partial<LlmConfig>) => void;
  onUseManaged: () => void;
}) {
  // Show the saved provider in the picker after a reload instead of an empty search box.
  const [providerQuery, setProviderQuery] = useState(() => {
    const saved = getProviderDefinition(config.providerId as ProviderId);
    return saved && saved.id !== 'managed'
      ? `${PROVIDER_REGION_LABEL[getProviderRegion(saved.id)]} · ${saved.name}`
      : '';
  });
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const def = getProviderDefinition(config.providerId as ProviderId);
  const isManaged = config.providerId === 'managed';
  const normalizedProviderQuery = providerQuery
    .replace(/^(中国大陆|国际|自定义)\s*[·:]\s*/, '')
    .trim()
    .toLowerCase();
  const providerOptions = getBrowserProviderDefinitions()
    .filter(
      (provider) =>
        provider.browserSupported &&
        provider.id !== 'managed' &&
        (!normalizedProviderQuery ||
          provider.name.toLowerCase().includes(normalizedProviderQuery) ||
          provider.id.toLowerCase().includes(normalizedProviderQuery)),
    )
    .map((provider) => ({
      value: provider.id,
      label: provider.name,
      category: PROVIDER_REGION_LABEL[getProviderRegion(provider.id)],
    }))
    .sort((a, b) => {
      const rank = (category: string) =>
        category === '中国大陆' ? 0 : category === '国际' ? 1 : 2;
      return rank(a.category) - rank(b.category) || a.label.localeCompare(b.label, 'zh-CN');
    });

  function selectProvider(providerId: ProviderId) {
    // Don't keep the previous provider's key and baseUrl when switching — they are
    // meaningless on the new service, and keeping them only makes "why is auth
    // failing" hard to track down.
    update({ ...createProviderSettings(providerId), rememberApiKey: config.rememberApiKey });
  }

  return (
    <AdvancedSection title="使用自己的 API">
      {import.meta.env.DEV && (
        // Local development only (stripped from builds): scripts/dev/test-model-proxy.mjs
        // holds the real key server-side, so nothing secret is typed into the page.
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            update({
              ...createProviderSettings('custom'),
              apiKey: 'local-test',
              baseUrl: `${window.location.origin}/dev-llm/v1`,
              model: 'claude-sonnet-5-5',
              endpoint: 'chat/completions',
              useStrict: false,
              rememberApiKey: true,
            })
          }
        >
          使用本地测试模型
        </Button>
      )}
      <label className="relative flex flex-col gap-1.5">
        <span className="text-xs text-[var(--text-soft)]">服务商</span>
        <Input
          value={providerQuery}
          onChange={(event) => {
            const selected = event.target.value.replace(/^(中国大陆|国际|自定义) · /, '');
            const value = providerOptions.find((option) => option.label === selected)?.value;
            setProviderQuery(event.target.value);
            setProviderMenuOpen(true);
            if (value) selectProvider(value as ProviderId);
          }}
          onFocus={() => setProviderMenuOpen(true)}
          onBlur={() => window.setTimeout(() => setProviderMenuOpen(false), 120)}
          placeholder="搜索"
          aria-label="搜索并选择服务商"
          role="combobox"
          aria-expanded={providerMenuOpen}
          aria-controls="llm-provider-options"
        />
        {providerMenuOpen && providerOptions.length > 0 ? (
          <div
            id="llm-provider-options"
            role="listbox"
            className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 isolate overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1 shadow-lg"
          >
            {providerOptions.map((option, index) => {
              const previous = providerOptions[index - 1];
              const showCategory = !previous || previous.category !== option.category;
              return (
                <div key={option.value}>
                  {showCategory ? (
                    <div className="px-3 pb-1 pt-2 text-[11px] font-semibold text-[var(--text-faint)]">
                      {option.category}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={config.providerId === option.value}
                    className="flex w-full items-center rounded-[var(--radius-xs)] px-3 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--accent-soft)] aria-selected:bg-[var(--accent-soft)]"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setProviderQuery(`${option.category} · ${option.label}`);
                      selectProvider(option.value as ProviderId);
                      setProviderMenuOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </label>

      {def?.hint && !isManaged && <p className="text-xs text-[var(--text-faint)]">{def.hint}</p>}

      {!isManaged && (
        <>
          <ProviderCredentialFields
            config={{ ...config, providerId: config.providerId as ProviderId }}
            definition={def}
            update={update}
          />
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">模型</span>
            {def?.dialect === 'pi-ai' && def.piProviderKey ? (
              <PiModelField config={config} update={update} />
            ) : (
              <OpenAiModelField config={config} update={update} />
            )}
          </label>
          <ProviderRememberApiKey
            config={{ ...config, providerId: config.providerId as ProviderId }}
            definition={def}
            label="在当前设备记住 API 密钥"
            update={update}
          />
          {!isLlmConfigured(config) && <p className="text-xs text-[var(--danger)]">配置未完成</p>}
          <button
            type="button"
            className="w-fit text-xs text-[var(--accent)] hover:underline"
            onClick={() => {
              onUseManaged();
              // Keep the provider search a real user-entered search field.
              setProviderQuery('');
            }}
          >
            切换回猫愿模型
          </button>
        </>
      )}
    </AdvancedSection>
  );
}

function BehaviorSection() {
  const behaviorStore = useMemo(() => new BrowserAppSettingsStore(), []);
  const [behavior, setBehavior] = useState<ModelBehaviorSettings>(() =>
    behaviorStore.loadModelBehavior(),
  );
  useEffect(() => behaviorStore.subscribeModelBehavior(setBehavior), [behaviorStore]);

  function updateBehavior(patch: Partial<ModelBehaviorSettings>) {
    // Persisting dispatches a synchronous cross-module event so the mounted Agent
    // picks the change up immediately. Do that in the input handler, not inside a
    // React state-updater callback: the latter runs during render work and makes the
    // event update Agent's App while React is still rendering this one.
    const next = behaviorStore.saveModelBehavior({
      ...behaviorStore.loadModelBehavior(),
      ...patch,
    });
    setBehavior(next);
  }

  return (
    <AdvancedSection title="上下文与回复" note="仅本设备，下一条消息生效。">
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
            { value: 'full-history', label: '更多历史（自动限制上下文）' },
          ]}
        />
      </label>
      <label className="grid gap-2">
        <span className="flex items-center justify-between text-xs text-[var(--text-soft)]">
          <span>回复多样性</span>
          <output className="font-mono tabular-nums">{behavior.temperature.toFixed(2)}</output>
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
      </label>
    </AdvancedSection>
  );
}

function OpenAiModelField({
  config,
  update,
}: {
  config: LlmConfig;
  update: (patch: Partial<LlmConfig>) => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [status, setStatus] = useState('');
  const recommended = useRecommendedModel(config.providerId as ProviderId);

  async function refresh() {
    setStatus('正在加载模型…');
    try {
      const found = (
        await discoverBrowserProviderModels({
          ...config,
          providerId: config.providerId as ProviderId,
        })
      ).ids;
      setModels(found);
      setStatus(found.length ? `已加载 ${found.length} 个模型` : '未返回模型，可继续手动输入');
    } catch (error) {
      setModels(null);
      setStatus(`加载失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async function test() {
    setStatus('正在测试连接…');
    const started = performance.now();
    try {
      await testBrowserProviderConnection({
        ...config,
        providerId: config.providerId as ProviderId,
      });
      setStatus(`连接成功 · ${Math.round(performance.now() - started)} ms`);
    } catch (error) {
      setStatus(`连接失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  return (
    <div className="grid gap-2">
      <ModelCombobox
        value={config.model}
        onChange={(model) => update({ model })}
        options={(models ?? []).map((model) => ({ id: model, label: model }))}
        recommended={recommended}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-[var(--radius-ctl)] border px-3 py-2 text-xs"
          onClick={() => void refresh()}
        >
          刷新模型列表
        </button>
        <button
          type="button"
          className="rounded-[var(--radius-ctl)] border px-3 py-2 text-xs"
          onClick={() => void test()}
        >
          测试连接
        </button>
      </div>
      {status && (
        <span role="status" className="text-xs text-[var(--text-faint)]">
          {status}
        </span>
      )}
    </div>
  );
}

/**
 * Model picker backed by the models.dev catalog (pi-ai's bundled table only when the
 * catalog is unavailable). Any id can still be typed for models not listed yet.
 */
function PiModelField({
  config,
  update,
}: {
  config: LlmConfig;
  update: (patch: Partial<LlmConfig>) => void;
}) {
  const [models, setModels] = useState<PiAiModelInfo[] | null>(null);
  const [error, setError] = useState('');
  const recommended = useRecommendedModel(config.providerId as ProviderId);
  const typed = config.model.trim().toLowerCase();
  const active = models?.find((model) => model.id.toLowerCase() === typed);
  async function load() {
    if (models) return;
    setError('');
    try {
      const catalog = await discoverBrowserProviderModels({
        ...config,
        providerId: config.providerId as ProviderId,
      });
      setModels(catalog.details ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '未知错误');
    }
  }
  return (
    <div className="grid gap-1.5">
      <ModelCombobox
        value={config.model}
        onChange={(model) => update({ model })}
        options={(models ?? []).map((model) => ({
          id: model.id,
          label: model.name,
          detail: model.contextWindow ? formatTokens(model.contextWindow) : model.id,
        }))}
        recommended={recommended}
        onOpen={() => void load()}
      />
      {error && <span className="text-xs text-[var(--danger)]">模型目录读取失败：{error}</span>}
      {active ? (
        <span className="text-xs text-[var(--text-faint)]">
          {[
            active.contextWindow ? `上下文 ${formatTokens(active.contextWindow)}` : null,
            active.maxTokens ? `最大输出 ${formatTokens(active.maxTokens)}` : null,
            active.reasoning ? '支持推理' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      ) : models && typed ? (
        <span className="text-xs text-[var(--text-faint)]">
          目录中没有这个模型 ID，请确认拼写。
        </span>
      ) : null}
    </div>
  );
}

function formatTokens(value: number): string {
  return value >= 1_000_000
    ? `${Number((value / 1_000_000).toFixed(1))}M`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}K`
      : String(value);
}
