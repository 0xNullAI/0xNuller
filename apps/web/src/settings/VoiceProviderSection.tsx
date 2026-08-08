import { useState } from 'react';
import { Input, SettingSelect } from '@0xnullai/ui';
import {
  REALTIME_PROVIDER_DEFINITIONS,
  getRealtimeProviderDefinition,
} from '../../../voice/src/lib/realtime/providers';
import { loadSettings, saveSettings, type VoiceSettings } from '../../../voice/src/lib/settings';

/**
 * 语音（realtime）provider。
 *
 * 和文本 LLM 并列而不是混进同一组字段：realtime 是另一套协议，端点、鉴权、可调参数
 * 都不同（voice、语速这些文本侧根本没有）。硬凑成一组会让两边的必填项互相污染——
 * 用户会看到一堆对当前 provider 无意义的输入框。
 *
 * 直接读写 Voice 的设置模块而不是复制一份形状：复制等于又造一份真源，而合并的整个
 * 意义就是消掉那种东西。
 */
export function VoiceProviderSection() {
  // 每次挂载读一次即可——设置面板是弹窗，打开时组件才创建，所以初值天然是最新的。
  // 不用 effect 再读一遍：那是在 effect 里同步 setState，会多跑一次渲染+提交。
  const [settings, setSettings] = useState<VoiceSettings>(loadSettings);

  function update(updater: (prev: VoiceSettings) => VoiceSettings) {
    const next = updater(settings);
    setSettings(next);
    saveSettings(next);
  }

  const def = getRealtimeProviderDefinition(settings.activeProviderId);
  const current = settings.providers[settings.activeProviderId];

  function setField(key: 'apiKey' | 'model' | 'baseUrl' | 'deployment', value: string) {
    update((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [prev.activeProviderId]: { ...prev.providers[prev.activeProviderId], [key]: value },
      },
    }));
  }

  return (
    <section className="rounded-[14px] border border-[var(--surface-border)] p-4">
      <h3 className="text-sm font-semibold">语音服务</h3>
      <p className="mt-1 text-xs text-[var(--text-faint)]">
        实时语音通话用的模型。与上面的文本模型是两套独立的服务。
      </p>

      <div className="mt-3 flex flex-col gap-3">
        <SettingSelect
          value={settings.activeProviderId}
          onValueChange={(value) =>
            update((prev) => ({
              ...prev,
              activeProviderId: value as VoiceSettings['activeProviderId'],
            }))
          }
          options={REALTIME_PROVIDER_DEFINITIONS.map((p) => ({ value: p.id, label: p.name }))}
        />

        {def?.hint && (
          <p className="rounded-[10px] bg-[var(--bg-soft)] px-3 py-2 text-xs leading-relaxed text-[var(--text-soft)]">
            {def.hint}
          </p>
        )}

        {def?.fields.map((field) => (
          <label key={field.key} className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">{field.label}</span>
            <Input
              type={field.key === 'apiKey' ? 'password' : 'text'}
              value={(current?.[field.key] as string) ?? ''}
              placeholder={field.placeholder}
              onChange={(e) => setField(field.key, e.target.value)}
            />
          </label>
        ))}
      </div>
    </section>
  );
}
