import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Input } from '@0xnullai/ui';
import {
  createProviderSettings,
  CUSTOM_PLACEHOLDER_BASE_URL,
  CUSTOM_PROVIDER_PRESETS,
  customProviderPreset,
  customProviderPresetFor,
  CUSTOM_PLACEHOLDER_MODEL,
  isLlmConfigured,
  loadLlmConfig,
  saveLlmConfig,
  subscribeLlmConfig,
  type LlmConfig,
} from '@0xnullai/llm-providers';
import { VoiceTimbreField } from './VoiceTimbreField';
import { VideoProviderSection } from './VideoProviderSection';
import { ProxySection } from './ProxySection';
import {
  discoverBrowserProviderModels,
  testBrowserProviderConnection,
} from '@dg-agent/agent-browser/llm';
import { AdvancedSubpage } from './SettingsAdvanced';
import { SelectRow, SettingsGroup, SettingsPage, SettingsRow, SwitchRow } from './settings-list';
import { SecretHint } from './SecretHint';
import { Brain, SlidersHorizontal } from 'lucide-react';
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

export function AiTab({
  initialSection,
  onOpenMemory,
}: {
  initialSection?: AiSettingsSection;
  /** Opens 个人记忆; absent when signed out, since memories live on the account. */
  onOpenMemory?: () => void;
}) {
  const [page, setPage] = useState<'main' | 'advanced'>(
    initialSection === 'video' ? 'advanced' : 'main',
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

  if (page === 'advanced')
    return (
      <AdvancedSubpage title="AI · 高级" onBack={closeSubpage}>
        <SettingsPage>
          <CustomModelGroup config={config} update={update} onUseManaged={switchToManaged} />
          <ProxySection />
          <SettingsGroup label="Video 视觉模型" footer="Video 看摄像头画面时使用。">
            <div className="flex flex-col gap-3 p-4">
              <VideoProviderSection />
            </div>
          </SettingsGroup>
        </SettingsPage>
      </AdvancedSubpage>
    );

  const managed = config.providerId === 'managed';
  return (
    <SettingsPage>
      {onOpenMemory ? (
        <SettingsGroup label="记忆">
          <SettingsRow icon={Brain} label="个人记忆" onClick={onOpenMemory} />
        </SettingsGroup>
      ) : null}
      <SettingsGroup label="语音">
        <VoiceTimbreField />
      </SettingsGroup>
      <SettingsGroup label="高级">
        <SettingsRow
          icon={SlidersHorizontal}
          label="自定义模型与网络代理"
          value={[managed ? '' : '自定义模型', loadProxy().enabled ? '代理' : '']
            .filter(Boolean)
            .join(' · ')}
          onClick={() => setPage('advanced')}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

/** 自定义模型: one switch, and the endpoint fields right under it while it is on. */
function CustomModelGroup({
  config,
  update,
  onUseManaged,
}: {
  config: LlmConfig;
  update: (patch: Partial<LlmConfig>) => void;
  onUseManaged: () => void;
}) {
  const custom = config.providerId === 'custom';
  const configured = isLlmConfigured(config);
  return (
    <SettingsGroup
      label="自定义模型"
      footer={
        custom ? (
          configured ? (
            '文字聊天改用你自己的接口，费用由你的服务商结算，不消耗 Credit。语音、生成图片和记忆仍使用猫愿服务。'
          ) : (
            <span className="text-[var(--danger)]">
              还差接口地址、API 密钥或模型，填好后才会生效。
            </span>
          )
        ) : (
          '关闭时使用猫愿模型。开启后可接入任意 OpenAI 兼容接口。'
        )
      }
    >
      <SwitchRow
        label="使用自定义模型"
        checked={custom}
        onCheckedChange={(on) =>
          on
            ? // Start from a clean custom config; nothing from managed applies to it.
              update({ ...createProviderSettings('custom'), rememberApiKey: config.rememberApiKey })
            : onUseManaged()
        }
      />
      {custom && (
        <>
          <SelectRow
            label="服务商"
            value={customProviderPresetFor(config.baseUrl) ?? 'other'}
            onChange={(id) => {
              const preset = CUSTOM_PROVIDER_PRESETS.find((item) => item.id === id);
              update(
                preset
                  ? {
                      baseUrl: preset.baseUrl,
                      endpoint: 'endpoint' in preset ? preset.endpoint : 'chat/completions',
                      model: CUSTOM_PLACEHOLDER_MODEL,
                    }
                  : { baseUrl: CUSTOM_PLACEHOLDER_BASE_URL },
              );
            }}
            options={[
              ...CUSTOM_PROVIDER_PRESETS.map(({ id, label }) => ({ value: id, label })),
              { value: 'other', label: '其他（手动填写）' },
            ]}
          />
          <div className="flex flex-col gap-3 border-b border-[var(--surface-border)] px-4 py-3">
            <Field label="接口地址">
              <Input
                type="url"
                // The stored placeholder means "not set yet": show an empty field.
                value={config.baseUrl === CUSTOM_PLACEHOLDER_BASE_URL ? '' : config.baseUrl}
                placeholder={CUSTOM_PLACEHOLDER_BASE_URL}
                onChange={(event) => update({ baseUrl: event.target.value })}
              />
            </Field>
            <Field label="API 密钥">
              <Input
                type="password"
                value={config.apiKey}
                onChange={(event) => update({ apiKey: event.target.value })}
              />
              <SecretHint value={config.apiKey} />
            </Field>
            <Field label="模型">
              <OpenAiModelField config={config} update={update} />
            </Field>
          </div>
          <SelectRow
            label="接口类型"
            value={config.endpoint}
            onChange={(endpoint) => update({ endpoint: endpoint as LlmConfig['endpoint'] })}
            options={[
              { value: 'chat/completions', label: 'Chat Completions' },
              { value: 'responses', label: 'Responses' },
            ]}
          />
          <SwitchRow
            label="严格 Schema"
            checked={config.useStrict}
            onCheckedChange={(useStrict) => update({ useStrict })}
          />
          <SwitchRow
            label="支持图片输入"
            checked={config.imageInput}
            onCheckedChange={(imageInput) => update({ imageInput })}
          />
          <SwitchRow
            label="在本设备记住 API 密钥"
            checked={config.rememberApiKey}
            onCheckedChange={(rememberApiKey) => update({ rememberApiKey })}
          />
        </>
      )}
      {import.meta.env.DEV && (
        // Local development only (stripped from builds): scripts/dev/test-model-proxy.mjs
        // holds the real key server-side, so nothing secret is typed into the page.
        <SettingsRow
          label="使用本地测试模型（开发版）"
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
        />
      )}
    </SettingsGroup>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-[var(--text-soft)]">{label}</span>
      {children}
    </label>
  );
}

function OpenAiModelField({
  config,
  update,
}: {
  config: LlmConfig;
  update: (patch: Partial<LlmConfig>) => void;
}) {
  // Results belong to one address + key; changing either makes the old list and message stale.
  const service = `${config.baseUrl}\u0000${config.apiKey}`;
  const [result, setResult] = useState<{
    service: string;
    models: string[] | null;
    status: string;
  } | null>(null);
  const current = result?.service === service ? result : null;
  const models = current?.models ?? null;
  const status = current?.status ?? '';
  const preset = customProviderPreset(config.baseUrl);
  const listable = !preset || !('listModels' in preset) || preset.listModels !== false;
  const suggested = preset && 'models' in preset ? preset.models : [];
  const ready =
    listable &&
    Boolean(config.apiKey.trim()) &&
    Boolean(config.baseUrl.trim()) &&
    config.baseUrl !== CUSTOM_PLACEHOLDER_BASE_URL;

  async function refresh() {
    setResult({ service, models, status: '正在加载模型…' });
    try {
      const found = await discoverBrowserProviderModels(config);
      setResult({
        service,
        models: found,
        status: found.length ? `已加载 ${found.length} 个模型` : '未返回模型，可继续手动输入',
      });
    } catch (error) {
      setResult({
        service,
        models: null,
        status: `加载失败：${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  }

  // The list follows the service: load it once an address and key are both filled in.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void refresh(), 600);
    return () => window.clearTimeout(timer);
    // refresh reads the latest config; re-run only when the address or key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, service]);

  async function test() {
    setResult({ service, models, status: '正在测试连接…' });
    const started = performance.now();
    try {
      await testBrowserProviderConnection(config);
      setResult({
        service,
        models,
        status: `连接成功 · ${Math.round(performance.now() - started)} ms`,
      });
    } catch (error) {
      setResult({
        service,
        models,
        status: `连接失败：${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  }

  return (
    <div className="grid gap-2">
      <ModelCombobox
        value={config.model === CUSTOM_PLACEHOLDER_MODEL ? '' : config.model}
        onChange={(model) => update({ model })}
        options={(models ?? suggested).map((model) => ({ id: model, label: model }))}
      />
      <div className="flex flex-wrap gap-2">
        {listable && (
          <button
            type="button"
            className="rounded-[var(--radius-ctl)] border px-3 py-2 text-xs"
            onClick={() => void refresh()}
          >
            刷新模型列表
          </button>
        )}
        <button
          type="button"
          className="rounded-[var(--radius-ctl)] border px-3 py-2 text-xs"
          onClick={() => void test()}
        >
          测试连接
        </button>
      </div>
      {(status || !listable) && (
        <span role="status" className="text-xs text-[var(--text-faint)]">
          {status ||
            '这家服务商不支持在浏览器里读取模型列表，可从上面的常用模型里选，或填控制台里的模型 ID。'}
        </span>
      )}
    </div>
  );
}
