import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@0xnullai/ui';
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
import { ProxySection } from './ProxySection';
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
import { AdvancedSubpage } from './SettingsAdvanced';
import { SelectRow, SettingsGroup, SettingsPage, SettingsRow, SliderRow } from './settings-list';
import { Camera, Globe, KeyRound } from 'lucide-react';
import { loadProxy } from '@0xnullai/settings';
import { ModelCombobox } from './ModelCombobox';

/**
 * AI configuration. Agent, Voice and Video are configured here but keep separate stores.
 *
 * The page shows the model, the voice and context/reply behaviour. Only bring-your-own-API
 * configuration (text and Video) sits on the 高级 sub-page. Agent and Chat share the text config; Video
 * (managed vision or a custom endpoint marked as image-capable, never copies Agent
 * credentials) stays a separate section so their required fields do not mix. Realtime voice is managed-only: its one setting
 * is the voice on the main page.
 */
export type AiSettingsSection = 'video';

export function AiTab({ initialSection }: { initialSection?: AiSettingsSection }) {
  const [page, setPage] = useState<'main' | 'own-api' | 'proxy' | 'video'>(
    initialSection === 'video' ? 'video' : 'main',
  );
  const [config, setConfig] = useState<LlmConfig>(loadLlmConfig);
  const closeSubpage = useCallback(() => setPage('main'), []);

  useEffect(() => subscribeLlmConfig(setConfig), []);

  function update(patch: Partial<LlmConfig>) {
    const next = { ...config, ...patch };
    setConfig(next);
    saveLlmConfig(next);
  }

  function switchToManaged() {
    update({ ...createProviderSettings('managed'), rememberApiKey: config.rememberApiKey });
  }

  if (page === 'own-api')
    return (
      <AdvancedSubpage title="使用自己的 API" onBack={closeSubpage}>
        <OwnApiSection config={config} update={update} onUseManaged={switchToManaged} />
      </AdvancedSubpage>
    );
  if (page === 'proxy')
    return (
      <AdvancedSubpage title="网络代理" onBack={closeSubpage}>
        <ProxySection />
      </AdvancedSubpage>
    );
  if (page === 'video')
    return (
      <AdvancedSubpage title="Video 视觉模型" onBack={closeSubpage}>
        <VideoProviderSection />
      </AdvancedSubpage>
    );

  const managed = config.providerId === 'managed';
  return (
    <SettingsPage>
      <SettingsGroup label="模型" footer={managed ? '登录后按用量消耗 Credit。' : undefined}>
        <SettingsRow label="对话模型" value={managed ? '猫愿模型' : '自己的 API'} />
      </SettingsGroup>
      <SettingsGroup label="语音">
        <VoiceTimbreField />
      </SettingsGroup>
      <BehaviorSection />
      <SettingsGroup label="高级">
        <SettingsRow
          icon={KeyRound}
          label="使用自己的 API"
          value={managed ? '未使用' : '使用中'}
          onClick={() => setPage('own-api')}
        />
        <SettingsRow
          icon={Globe}
          label="网络代理"
          value={loadProxy().enabled ? '已开启' : '关闭'}
          onClick={() => setPage('proxy')}
        />
        <SettingsRow icon={Camera} label="Video 视觉模型" onClick={() => setPage('video')} />
      </SettingsGroup>
    </SettingsPage>
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
    <div className="flex flex-col gap-3">
      {import.meta.env.DEV && (
        // Local development only (stripped from builds): scripts/dev/test-model-proxy.mjs
        // holds the real key server-side, so nothing secret is typed into the page.
        <Button
          variant="secondary"
          size="sm"
          className="w-fit"
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
    </div>
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
    <SettingsGroup label="回复" footer="仅本设备，下一条消息生效。">
      <SelectRow
        label="上下文"
        value={behavior.modelContextStrategy}
        onChange={(value) =>
          updateBehavior({
            modelContextStrategy: value as ModelBehaviorSettings['modelContextStrategy'],
          })
        }
        options={[
          { value: 'last-user-turn', label: '基础（最近 1 轮）' },
          { value: 'last-five-user-turns', label: '中等（最近 5 轮）' },
          { value: 'full-history', label: '更多历史' },
        ]}
      />
      <SliderRow
        label="回复多样性"
        min={0}
        max={1}
        step={0.05}
        value={behavior.temperature}
        format={(value) => value.toFixed(2)}
        onChange={(temperature) => updateBehavior({ temperature })}
      />
    </SettingsGroup>
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
