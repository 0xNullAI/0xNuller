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
 * AI 配置。文本与语音都在这里。
 *
 * 文本这份 Agent 与 Chat 共用——合并前两边各存各的，用户在一处配好到另一处还得
 * 再配一遍。语音那份是另一套端点与鉴权（realtime 协议），所以是并列的一节而不是
 * 混进同一组字段里：硬凑成一组会让两边的必填项互相污染。
 *
 * 代理也放这里：它影响的正是这些模型请求。**网页端只有 HTTP 反代可行**——浏览器
 * 不允许页面自行选择 SOCKS 代理，那是操作系统层的设置。给网页端一个 SOCKS 开关等于
 * 给一个看起来能用、实际永不生效的按钮，所以这里按运行时把它禁掉并说明原因。
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
      <section>
        <h3 className="text-sm font-semibold">模型服务</h3>
        <p className="mt-1 text-xs text-[var(--text-faint)]">Agent 与 Chat 共用这一份配置。</p>
        <div className="mt-3">
          <SettingSelect
            value={config.providerId}
            onValueChange={(value) => {
              const next = defaultLlmConfig();
              // 换 provider 时不要保留上一家的 key 与 baseUrl——它们在新的服务上无意义，
              // 留着只会让「为什么报鉴权失败」变得难查。
              update({ ...next, providerId: value });
            }}
            // free 本来就在 PROVIDER_DEFINITIONS 里，不要再手工加一条——同一个 value
            // 出现两次时 Radix 会把两个标签都渲染进触发器，显示成「免费体验免费体验」。
            options={PROVIDER_DEFINITIONS.filter((p) => p.browserSupported).map((p) => ({
              value: p.id,
              label: p.name,
            }))}
          />
        </div>
      </section>

      {isFree ? (
        <p className="rounded-[10px] bg-[var(--bg-soft)] px-3 py-2.5 text-xs leading-relaxed text-[var(--text-soft)]">
          免费体验无需任何配置，由代理服务提供。想用自己的额度或更强的模型时再来这里换。
        </p>
      ) : (
        <section className="flex flex-col gap-3">
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
        </section>
      )}

      {!isLlmConfigured(config) && (
        <p className="rounded-[10px] border border-[var(--warning-border)] bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--text-soft)]">
          还差一项配置，当前无法发起对话。
        </p>
      )}

      <p className="text-xs leading-relaxed text-[var(--text-faint)]">
        API Key 存在本机浏览器里，不加密——同源脚本与浏览器扩展都读得到。真正需要保密的
        部署应该自建代理，让密钥只存在于服务端。
      </p>

      <VoiceProviderSection />
      <ProxySection />
    </div>
  );
}
