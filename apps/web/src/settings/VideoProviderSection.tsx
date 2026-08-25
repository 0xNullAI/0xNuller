import { useEffect, useMemo, useState } from 'react';
import { Input, SettingSelect } from '@0xnullai/ui';
import {
  PROVIDER_DEFINITIONS,
  VIDEO_LLM_CONFIG_VERSION,
  createProviderSettings,
  filterVideoModelIds,
  getProviderDefinition,
  getProviderImageModels,
  isVideoLlmConfigured,
  loadVideoLlmConfig,
  resolveProviderRequestUrl,
  saveVideoLlmConfig,
  subscribeVideoLlmConfig,
  supportsProviderModelImageInput,
  type ProviderId,
  type VideoLlmConfig,
} from '@0xnullai/llm-providers';
import { ListModelsError, listModels } from '@dg-agent/providers-openai-http';
import type { PiAiProviderKey } from '@dg-agent/providers-pi-http/provider-keys';

const VIDEO_PROVIDERS = PROVIDER_DEFINITIONS.filter(
  (provider) => provider.browserSupported && provider.imageInput === 'known-models',
);

export function VideoProviderSection() {
  const [config, setConfig] = useState<VideoLlmConfig>(loadVideoLlmConfig);
  const [discoveredModels, setDiscoveredModels] = useState<string[] | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => subscribeVideoLlmConfig(setConfig), []);

  const definition = getProviderDefinition(config.providerId as ProviderId);
  const knownModels = useMemo(
    () =>
      definition ? filterVideoModelIds(definition.id, getProviderImageModels(definition.id)) : [],
    [definition],
  );
  const models = discoveredModels
    ? [...new Set([...knownModels, ...discoveredModels])]
    : knownModels;
  const validProvider = Boolean(
    definition?.browserSupported && definition.imageInput === 'known-models',
  );
  const validModel = Boolean(
    definition && supportsProviderModelImageInput(definition.id, config.model),
  );

  function update(patch: Partial<VideoLlmConfig>) {
    const next = { ...config, ...patch, version: VIDEO_LLM_CONFIG_VERSION };
    setConfig(next);
    saveVideoLlmConfig(next);
  }

  function selectProvider(providerId: ProviderId) {
    const settings = createProviderSettings(providerId);
    setDiscoveredModels(null);
    setStatus('');
    update({
      ...settings,
      version: VIDEO_LLM_CONFIG_VERSION,
      // Provider switches require an explicit vision-model choice. Never carry over
      // credentials or silently substitute a model from the previous provider.
      apiKey: '',
      model: '',
      rememberApiKey: config.rememberApiKey,
    });
  }

  async function refreshModels() {
    if (!definition) return;
    setStatus('正在加载模型…');
    try {
      const found =
        definition.dialect === 'pi-ai' && definition.piProviderKey
          ? (
              await import('@dg-agent/providers-pi-http').then(({ listModelsForProvider }) =>
                listModelsForProvider(definition.piProviderKey as PiAiProviderKey),
              )
            ).map((model) => model.id)
          : await listModels({
              baseUrl: resolveProviderRequestUrl(config.baseUrl),
              apiKey: config.apiKey,
            });
      const filtered = filterVideoModelIds(definition.id, found);
      setDiscoveredModels(filtered);
      setStatus(
        filtered.length
          ? `已加载 ${filtered.length} 个明确支持图片输入的模型`
          : '返回结果中没有明确支持图片输入的模型',
      );
    } catch (error) {
      setDiscoveredModels(null);
      setStatus(
        `加载失败：${error instanceof ListModelsError || error instanceof Error ? error.message : '未知错误'}`,
      );
    }
  }

  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
      <h3 className="text-sm font-semibold">Video 视觉模型</h3>
      <p className="mt-1 text-xs leading-relaxed text-[var(--text-faint)]">
        仅保存在当前设备，与 Agent 和 Voice 的服务商、凭据及模型完全独立，不随账户同步。
      </p>

      <div className="mt-3 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">服务商</span>
          <SettingSelect
            value={config.providerId}
            onValueChange={(value) => selectProvider(value as ProviderId)}
            options={VIDEO_PROVIDERS.map((provider) => ({
              value: provider.id,
              label: provider.name,
            }))}
          />
        </label>

        {definition?.fields
          .filter((field) => field.key !== 'model' && field.key !== 'apiKey')
          .map((field) => (
            <label key={field.key} className="flex flex-col gap-1.5">
              <span className="text-xs text-[var(--text-soft)]">{field.label}</span>
              {field.type === 'select' ? (
                <SettingSelect
                  value={String(config[field.key as 'endpoint' | 'useStrict'])}
                  onValueChange={(value) =>
                    update(
                      field.key === 'useStrict'
                        ? { useStrict: value === 'true' }
                        : { endpoint: value as VideoLlmConfig['endpoint'] },
                    )
                  }
                  options={field.options ?? []}
                />
              ) : (
                <Input
                  value={(config[field.key as keyof VideoLlmConfig] as string) ?? ''}
                  placeholder={field.placeholder}
                  onChange={(event) => update({ [field.key]: event.target.value })}
                />
              )}
            </label>
          ))}

        {definition?.fields.some((field) => field.key === 'apiKey') && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">API 密钥</span>
            <Input
              type="password"
              value={config.apiKey}
              onChange={(event) => update({ apiKey: event.target.value })}
            />
          </label>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">视觉模型</span>
          <select
            aria-label="Video 视觉模型"
            value={validModel && models.includes(config.model) ? config.model : '__invalid__'}
            onChange={(event) => {
              if (event.target.value !== '__invalid__') update({ model: event.target.value });
            }}
            className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
          >
            <option value="__invalid__" disabled>
              请选择明确支持图片输入的模型
            </option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>

        {!validProvider ? (
          <p role="alert" className="text-xs text-[var(--danger)]">
            已保存的服务商“{config.providerId}”不支持浏览器图片输入，Video 已停用。请重新选择。
          </p>
        ) : (
          !validModel &&
          config.model.trim() && (
            <p role="alert" className="text-xs text-[var(--danger)]">
              已保存的模型“{config.model}”未被明确标记为支持图片输入，Video 已停用。请重新选择。
            </p>
          )
        )}

        <button
          type="button"
          className="w-fit rounded-[var(--radius-ctl)] border px-3 py-2 text-xs"
          onClick={() => void refreshModels()}
        >
          刷新视觉模型列表
        </button>
        {status && (
          <span role="status" className="text-xs text-[var(--text-faint)]">
            {status}
          </span>
        )}

        {definition?.fields.some((field) => field.key === 'apiKey') && (
          <label className="flex items-center justify-between gap-3 text-xs text-[var(--text-soft)]">
            <span>仅在当前设备记住 API 密钥</span>
            <input
              type="checkbox"
              checked={config.rememberApiKey}
              onChange={(event) => update({ rememberApiKey: event.target.checked })}
            />
          </label>
        )}
      </div>

      {!isVideoLlmConfigured(config) && (
        <p className="mt-3 text-xs text-[var(--danger)]">Video 配置未完成，无法开始视觉解释。</p>
      )}
    </section>
  );
}
