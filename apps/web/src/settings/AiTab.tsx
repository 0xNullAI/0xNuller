import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Input, SettingSelect } from '@0xnullai/ui';
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
import { VoiceProviderSection } from './VoiceProviderSection';
import { VideoProviderSection } from './VideoProviderSection';
import { BrowserAppSettingsStore, type ModelBehaviorSettings } from '@dg-agent/storage-browser';
import {
  discoverBrowserProviderModels,
  testBrowserProviderConnection,
} from '@dg-agent/agent-browser/llm';
import type { PiAiModelInfo } from '@dg-agent/providers-pi-http';
import { ProviderCredentialFields, ProviderRememberApiKey } from './ProviderCredentialFields';

/**
 * AI configuration. Agent, Voice and Video are selected here but keep separate stores.
 *
 * Agent and Chat share this text config — before the merge each side stored its
 * own, so a user who configured it in one place had to configure it again in the
 * other. The voice one is a separate set of endpoints and auth (the realtime
 * protocol), so it is a sibling section rather than being mixed into the same group
 * of fields: forcing them into one group makes the two sides' required fields
 * pollute each other. Video is separate again: its credentials never copy from Agent
 * and its model must pass the explicit image-input allowlist.
 *
 * Network proxy configuration is global and lives under General settings so every
 * model surface uses one endpoint instead of asking for the same value three times.
 */
export type AiSettingsSection = 'agent' | 'voice' | 'video';

const PROVIDER_REGION_LABEL = {
  mainland: '中国大陆',
  international: '国际',
  custom: '自定义',
} as const;

const AI_SECTIONS: ReadonlyArray<readonly [AiSettingsSection, string]> = [
  ['agent', 'Agent'],
  ['voice', 'Voice'],
  ['video', 'Video'],
];

export function AiTab({ initialSection = 'agent' }: { initialSection?: AiSettingsSection }) {
  const [section, setSection] = useState<AiSettingsSection>(initialSection);
  const [config, setConfig] = useState<LlmConfig>(loadLlmConfig);
  const behaviorStore = useMemo(() => new BrowserAppSettingsStore(), []);
  const [behavior, setBehavior] = useState<ModelBehaviorSettings>(() =>
    behaviorStore.loadModelBehavior(),
  );
  const [providerQuery, setProviderQuery] = useState('');
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [ownApiOpen, setOwnApiOpen] = useState(() => config.providerId !== 'managed');
  const [advancedOpen, setAdvancedOpen] = useState(() => config.providerId === 'custom');

  useEffect(() => subscribeLlmConfig(setConfig), []);
  useEffect(() => behaviorStore.subscribeModelBehavior(setBehavior), [behaviorStore]);

  function update(patch: Partial<LlmConfig>) {
    const next = { ...config, ...patch };
    setConfig(next);
    saveLlmConfig(next);
  }

  function updateBehavior(patch: Partial<ModelBehaviorSettings>) {
    // Persisting dispatches a synchronous cross-module event so the mounted Agent
    // picks the change up immediately. Do that in the input handler, not inside a
    // React state-updater callback: the latter runs during AiTab's render work and
    // makes the event update Agent's App while React is still rendering this one.
    const next = behaviorStore.saveModelBehavior({
      ...behaviorStore.loadModelBehavior(),
      ...patch,
    });
    setBehavior(next);
  }

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

  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" aria-label="AI 模块" className="grid grid-cols-3 gap-2">
        {AI_SECTIONS.map(([id, label], index) => (
          <button
            key={id}
            id={`ai-${id}-tab`}
            type="button"
            role="tab"
            aria-selected={section === id}
            aria-controls={`ai-${id}-panel`}
            tabIndex={section === id ? 0 : -1}
            onClick={() => setSection(id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const offset = event.key === 'ArrowRight' ? 1 : -1;
              const next =
                AI_SECTIONS[(index + offset + AI_SECTIONS.length) % AI_SECTIONS.length]![0];
              setSection(next);
              document.getElementById(`ai-${next}-tab`)?.focus();
            }}
            className={
              'rounded-[var(--radius-ctl)] border px-3 py-2 text-sm ' +
              (section === id
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]'
                : 'border-[var(--surface-border)] text-[var(--text-soft)]')
            }
          >
            {label}
          </button>
        ))}
      </div>

      <section
        id="ai-agent-panel"
        role="tabpanel"
        aria-labelledby="ai-agent-tab"
        hidden={section !== 'agent'}
        className="rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4"
      >
        <h3 className="text-sm font-semibold">Agent 模型</h3>
        {isManaged ? (
          <div className="mt-3 grid gap-3 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--accent-soft)] p-3">
            <div>
              <div className="text-sm font-semibold">0xNullAI Credit 模型</div>
              <p className="mt-1 text-xs text-[var(--text-soft)]">
                由 Cloudflare Workers AI 提供，登录后按实际用量结算。
              </p>
            </div>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-[var(--text-soft)]">模型档位</span>
              <SettingSelect
                value={config.model}
                onValueChange={(model) => update({ model })}
                options={MANAGED_MODEL_OPTIONS.map((option) => ({
                  value: option.id,
                  label: option.name,
                }))}
              />
            </label>
            <p className="text-xs text-[var(--text-faint)]">
              {MANAGED_MODEL_OPTIONS.find((option) => option.id === config.model)?.description}
            </p>
          </div>
        ) : (
          <button
            type="button"
            className="mt-3 text-xs text-[var(--accent)] hover:underline"
            onClick={() => {
              update({
                ...createProviderSettings('managed'),
                rememberApiKey: config.rememberApiKey,
              });
              // Keep the provider search as a real user-entered search field. Do not
              // repopulate it with the managed provider when switching back.
              setProviderQuery('');
              setOwnApiOpen(false);
            }}
          >
            切换回 0xNullAI 模型
          </button>
        )}

        {!ownApiOpen ? (
          <button
            type="button"
            className="mt-3 w-fit text-xs text-[var(--text-soft)] hover:text-[var(--text)] hover:underline"
            onClick={() => setOwnApiOpen(true)}
          >
            使用自己的 API
          </button>
        ) : (
          <div className="mt-3 grid gap-2 rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold">自己的 API</span>
              {isManaged ? (
                <button
                  type="button"
                  className="text-xs text-[var(--text-faint)]"
                  onClick={() => setOwnApiOpen(false)}
                >
                  收起
                </button>
              ) : null}
            </div>
            <label className="relative flex flex-col gap-1.5">
              <span className="text-xs text-[var(--text-soft)]">搜索并选择服务商</span>
              <Input
                value={providerQuery}
                onChange={(event) => {
                  const selected = event.target.value.replace(/^(中国大陆|国际|自定义) · /, '');
                  const value = providerOptions.find((option) => option.label === selected)?.value;
                  setProviderQuery(event.target.value);
                  setProviderMenuOpen(true);
                  if (!value) return;
                  const next = createProviderSettings(value as ProviderId);
                  // Don't keep the previous provider's key and baseUrl when switching — they are
                  // meaningless on the new service, and keeping them only makes "why is auth
                  // failing" hard to track down.
                  update({ ...next, rememberApiKey: config.rememberApiKey });
                  if (value === 'custom') setAdvancedOpen(true);
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
                            update({
                              ...createProviderSettings(option.value as ProviderId),
                              rememberApiKey: config.rememberApiKey,
                            });
                            if (option.value === 'custom') setAdvancedOpen(true);
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
          </div>
        )}

        {def?.hint && !isManaged && (
          <p className="mt-2 rounded-[var(--radius-xs)] bg-[var(--accent-soft)] px-3 py-2 text-xs leading-relaxed text-[var(--text-soft)]">
            {def.hint}
          </p>
        )}

        {!isManaged && (
          <div className="mt-3 flex flex-col gap-3">
            <ProviderCredentialFields
              config={{ ...config, providerId: config.providerId as ProviderId }}
              definition={def}
              update={update}
              showAdvanced={advancedOpen}
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
            {def?.fields.some(
              (field) =>
                field.key === 'baseUrl' || field.key === 'endpoint' || field.key === 'useStrict',
            ) ? (
              <button
                type="button"
                className="w-fit text-xs text-[var(--text-faint)] hover:text-[var(--text)]"
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                {advancedOpen ? '收起高级设置' : '高级设置'}
              </button>
            ) : null}
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

      {section === 'voice' && (
        <div id="ai-voice-panel" role="tabpanel" aria-labelledby="ai-voice-tab">
          <VoiceProviderSection />
        </div>
      )}
      {section === 'video' && (
        <div id="ai-video-panel" role="tabpanel" aria-labelledby="ai-video-tab">
          <VideoProviderSection />
        </div>
      )}
    </div>
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
      {models ? (
        <SettingSelect
          value={config.model}
          onValueChange={(model) => update({ model })}
          options={[
            ...(config.model && !models.includes(config.model)
              ? [{ value: config.model, label: `${config.model}（自定义）` }]
              : []),
            ...models.map((model) => ({ value: model, label: model })),
          ]}
        />
      ) : (
        <Input
          value={config.model}
          onChange={(event) => update({ model: event.target.value })}
          placeholder="留空使用默认模型"
        />
      )}
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

function PiModelField({
  config,
  update,
}: {
  config: LlmConfig;
  update: (patch: Partial<LlmConfig>) => void;
}) {
  const [models, setModels] = useState<PiAiModelInfo[] | null>(null);
  const [error, setError] = useState('');
  const active = models?.find((model) => model.id === config.model.trim());
  async function inspect() {
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
    <div className="grid gap-2">
      <Input
        value={config.model}
        onChange={(event) => update({ model: event.target.value })}
        placeholder="输入模型 ID"
      />
      <button
        type="button"
        className="w-fit rounded-[var(--radius-ctl)] border px-3 py-2 text-xs"
        onClick={() => void inspect()}
      >
        查看模型信息
      </button>
      {error && <span className="text-xs text-[var(--danger)]">目录读取失败：{error}</span>}
      {models && (
        <span className="text-xs text-[var(--text-faint)]">
          {active
            ? `上下文 ${formatTokens(active.contextWindow)} · 最大输出 ${formatTokens(active.maxTokens)}${active.reasoning ? ' · 支持推理' : ''}`
            : `目录中暂无该模型；已知：${models
                .slice(0, 5)
                .map((model) => model.id)
                .join('、')}`}
        </span>
      )}
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
