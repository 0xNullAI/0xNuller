import { useEffect, useState } from 'react';
import { SettingSelect } from '@0xnullai/ui';
import {
  MANAGED_VISION_MODEL,
  PROVIDER_DEFINITIONS,
  VIDEO_LLM_CONFIG_VERSION,
  createProviderSettings,
  getProviderDefinition,
  isVideoLlmConfigured,
  loadVideoLlmConfig,
  saveVideoLlmConfig,
  subscribeVideoLlmConfig,
  type ProviderId,
  type VideoLlmConfig,
} from '@0xnullai/llm-providers';
import { discoverBrowserProviderModels } from '@dg-agent/agent-browser/llm';
import {
  ProviderCredentialFields,
  ProviderImageInputToggle,
  ProviderRememberApiKey,
} from './ProviderCredentialFields';
import { ModelCombobox } from './ModelCombobox';

export function VideoProviderSection() {
  const [config, setConfig] = useState<VideoLlmConfig>(loadVideoLlmConfig);
  const [models, setModels] = useState<string[] | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => subscribeVideoLlmConfig(setConfig), []);

  const definition = getProviderDefinition(config.providerId);
  const isManaged = config.providerId === 'managed';

  function update(patch: Partial<VideoLlmConfig>) {
    const next = { ...config, ...patch, version: VIDEO_LLM_CONFIG_VERSION };
    setConfig(next);
    saveVideoLlmConfig(next);
  }

  function selectProvider(providerId: ProviderId) {
    setModels(null);
    setStatus('');
    update({
      ...createProviderSettings(providerId),
      // Managed Video always uses its declared vision model. A custom endpoint starts
      // empty and text-only: never carry credentials over or assume image support.
      ...(providerId === 'managed' ? { model: MANAGED_VISION_MODEL } : { model: '' }),
      version: VIDEO_LLM_CONFIG_VERSION,
      rememberApiKey: config.rememberApiKey,
    });
  }

  async function refreshModels() {
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

  return (
    <div>
      <p className="text-xs text-[var(--text-faint)]">
        {isManaged ? '只有提交给模型的画面才消耗 Credit。' : '与 Agent 设置独立，仅本设备。'}
      </p>

      <div className="mt-3 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">服务商</span>
          <SettingSelect
            value={config.providerId}
            onValueChange={(value) => selectProvider(value as ProviderId)}
            options={PROVIDER_DEFINITIONS.filter((provider) => provider.browserSupported).map(
              (provider) => ({ value: provider.id, label: provider.name }),
            )}
          />
        </label>

        {!isManaged && (
          <>
            <ProviderCredentialFields config={config} definition={definition} update={update} />
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-[var(--text-soft)]">视觉模型</span>
              <ModelCombobox
                value={config.model}
                onChange={(model) => update({ model })}
                ariaLabel="Video 视觉模型"
                options={(models ?? []).map((model) => ({ id: model, label: model }))}
              />
            </label>
            <button
              type="button"
              className="w-fit rounded-[var(--radius-ctl)] border px-3 py-2 text-xs"
              onClick={() => void refreshModels()}
            >
              刷新模型列表
            </button>
            {status && (
              <span role="status" className="text-xs text-[var(--text-faint)]">
                {status}
              </span>
            )}
            <ProviderImageInputToggle config={config} update={update} />
            <ProviderRememberApiKey
              config={config}
              definition={definition}
              label="仅在当前设备记住 API 密钥"
              update={update}
            />
          </>
        )}
      </div>

      {!isVideoLlmConfigured(config) && (
        <p className="mt-3 text-xs text-[var(--danger)]">Video 配置未完成，无法开始视觉解释。</p>
      )}
    </div>
  );
}
