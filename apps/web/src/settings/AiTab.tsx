import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Button, SettingSelect } from '@0xnullai/ui';
import {
  createProviderSettings,
  getProviderDefinition,
  isLlmConfigured,
  loadLlmConfig,
  saveLlmConfig,
  subscribeLlmConfig,
  type LlmConfig,
} from '@0xnullai/llm-providers';
import { VoiceTimbreField } from './VoiceTimbreField';
import { VideoProviderSection } from './VideoProviderSection';
import { BrowserAppSettingsStore, type ModelBehaviorSettings } from '@dg-agent/storage-browser';
import {
  discoverBrowserProviderModels,
  testBrowserProviderConnection,
} from '@dg-agent/agent-browser/llm';
import {
  ProviderCredentialFields,
  ProviderImageInputToggle,
  ProviderRememberApiKey,
} from './ProviderCredentialFields';
import { AdvancedEntryRow, AdvancedSection, AdvancedSubpage } from './SettingsAdvanced';
import { ModelCombobox } from './ModelCombobox';

/**
 * AI configuration. Agent, Voice and Video are configured here but keep separate stores.
 *
 * The page shows only the model tier and the voice. Everything else (own API, context,
 * Video) sits on one flat 高级 sub-page. Agent and Chat share the text config; Video
 * (managed vision or a custom endpoint marked as image-capable, never copies Agent
 * credentials) stays a separate section so their required fields do not mix. Realtime voice is managed-only: its one setting
 * is the voice on the main page.
 */
export type AiSettingsSection = 'video';

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

  const def = getProviderDefinition(config.providerId);
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Agent 模型" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">模型</h3>
        {config.providerId === 'managed' ? (
          <p className="text-sm text-[var(--text-soft)]">猫愿模型 · 登录后按用量消耗 Credit。</p>
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
  const def = getProviderDefinition(config.providerId);
  const isManaged = config.providerId === 'managed';

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

      {isManaged ? (
        <Button
          variant="secondary"
          size="sm"
          className="w-fit"
          onClick={() =>
            // Start from a clean custom config; nothing from managed applies to it.
            update({ ...createProviderSettings('custom'), rememberApiKey: config.rememberApiKey })
          }
        >
          使用自定义接口
        </Button>
      ) : (
        <>
          {def?.hint && <p className="text-xs text-[var(--text-faint)]">{def.hint}</p>}
          <ProviderCredentialFields config={config} definition={def} update={update} />
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">模型</span>
            <OpenAiModelField config={config} update={update} />
          </label>
          <ProviderImageInputToggle config={config} update={update} />
          <ProviderRememberApiKey
            config={config}
            definition={def}
            label="在当前设备记住 API 密钥"
            update={update}
          />
          {!isLlmConfigured(config) && <p className="text-xs text-[var(--danger)]">配置未完成</p>}
          <button
            type="button"
            className="w-fit text-xs text-[var(--accent)] hover:underline"
            onClick={onUseManaged}
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

  async function refresh() {
    setStatus('正在加载模型…');
    try {
      const found = await discoverBrowserProviderModels(config);
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
      await testBrowserProviderConnection(config);
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
