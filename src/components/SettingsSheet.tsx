import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { HelpTip } from '@/components/HelpTip';
import {
  getRealtimeProviderDefinition,
  REALTIME_PROVIDER_DEFINITIONS,
  type RealtimeProviderId,
} from '@/lib/realtime/providers';
import type { VoiceSettings } from '@/lib/settings';
import type { BrowserPermissionMode } from '@/lib/permissions';

interface SettingsSheetProps {
  settings: VoiceSettings;
  updateSettings: (updater: (prev: VoiceSettings) => VoiceSettings) => void;
  disabled: boolean;
}

const PERMISSION_MODE_LABELS: Record<BrowserPermissionMode, string> = {
  confirm: '每次确认（默认，最严格）',
  timed: '通话期间免确认（5 分钟一续）',
  'allow-all': '完全放行（不推荐）',
};

export function SettingsSheet({ settings, updateSettings, disabled }: SettingsSheetProps) {
  const provider = getRealtimeProviderDefinition(settings.activeProviderId);
  const providerSettings = settings.providers[settings.activeProviderId];

  const setProviderField = (key: 'apiKey' | 'model' | 'baseUrl' | 'deployment' | 'voice', value: string) => {
    updateSettings((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [prev.activeProviderId]: { ...prev.providers[prev.activeProviderId], [key]: value },
      },
    }));
  };

  const setProviderSpeed = (value: number) => {
    updateSettings((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [prev.activeProviderId]: { ...prev.providers[prev.activeProviderId], speed: value },
      },
    }));
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          <Settings className="h-4 w-4" />
          设置
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex flex-col gap-0 p-0">
        <SheetHeader className="border-b border-[var(--surface-border)] px-4 py-3">
          <SheetTitle>设置</SheetTitle>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="space-y-6 p-4">
            <section className="settings-row-card space-y-3">
              <h3 className="settings-card-legend">语音 Provider</h3>

              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-sm text-[var(--text-soft)]">
                  Provider
                  <HelpTip text="xAI/OpenAI/Azure 走同一套客户端；智谱 GLM 免服务端中转，本地签名直连。" />
                </label>
                <Select
                  value={settings.activeProviderId}
                  onValueChange={(value) =>
                    updateSettings((prev) => ({ ...prev, activeProviderId: value as RealtimeProviderId }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REALTIME_PROVIDER_DEFINITIONS.map((def) => (
                      <SelectItem key={def.id} value={def.id}>
                        {def.name}
                        {def.pricePerMinuteUsd ? ` · $${def.pricePerMinuteUsd}/分钟` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {provider?.hint && <p className="text-xs text-[var(--text-faint)]">{provider.hint}</p>}
              </div>

              {provider?.fields.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <label className="text-sm text-[var(--text-soft)]">{field.label}</label>
                  <Input
                    type={field.type === 'password' ? 'password' : 'text'}
                    placeholder={field.placeholder}
                    value={providerSettings[field.key]}
                    onChange={(e) => setProviderField(field.key, e.target.value)}
                  />
                </div>
              ))}

              <div className="space-y-1.5">
                <label className="text-sm text-[var(--text-soft)]">音色</label>
                <Select value={providerSettings.voice} onValueChange={(value) => setProviderField('voice', value)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(provider?.staticVoices ?? []).map((voice) => (
                      <SelectItem key={voice} value={voice}>
                        {voice}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {provider?.voiceSource === 'api' && (
                  <p className="text-xs text-[var(--text-faint)]">
                    该 provider 支持更多音色，可直接输入音色 ID 覆盖上方选择。
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm text-[var(--text-soft)]">语速（0.7 - 1.5）</label>
                <Input
                  type="number"
                  min={0.7}
                  max={1.5}
                  step={0.1}
                  value={providerSettings.speed}
                  onChange={(e) => setProviderSpeed(Number(e.target.value))}
                />
              </div>
            </section>

            <section className="settings-row-card space-y-3">
              <h3 className="settings-card-legend">人设 / 系统指令</h3>
              <Textarea
                rows={10}
                value={settings.instructions}
                onChange={(e) =>
                  updateSettings((prev) => ({ ...prev, instructions: e.target.value }))
                }
              />
            </section>

            <section className="settings-row-card space-y-3">
              <h3 className="settings-card-legend">权限</h3>
              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-sm text-[var(--text-soft)]">
                  确认模式
                  <HelpTip text="通话开始时会用一次性授权覆盖为『通话期间免确认』，这里改的是默认档位。" />
                </label>
                <Select
                  value={settings.permissionMode}
                  onValueChange={(value) =>
                    updateSettings((prev) => ({ ...prev, permissionMode: value as BrowserPermissionMode }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PERMISSION_MODE_LABELS) as BrowserPermissionMode[]).map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {PERMISSION_MODE_LABELS[mode]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </section>

            <section className="settings-row-card space-y-3">
              <h3 className="settings-card-legend">郊狼安全上限</h3>
              <div className="grid grid-cols-2 gap-3">
                <NumberField
                  label="A 通道强度上限"
                  value={settings.coyoteSafety.maxStrengthA}
                  onChange={(v) => updateSettings((prev) => ({ ...prev, coyoteSafety: { ...prev.coyoteSafety, maxStrengthA: v } }))}
                />
                <NumberField
                  label="B 通道强度上限"
                  value={settings.coyoteSafety.maxStrengthB}
                  onChange={(v) => updateSettings((prev) => ({ ...prev, coyoteSafety: { ...prev.coyoteSafety, maxStrengthB: v } }))}
                />
                <NumberField
                  label="冷启动上限"
                  value={settings.coyoteSafety.maxColdStartStrength}
                  onChange={(v) => updateSettings((prev) => ({ ...prev, coyoteSafety: { ...prev.coyoteSafety, maxColdStartStrength: v } }))}
                />
                <NumberField
                  label="单次调节幅度"
                  value={settings.coyoteSafety.maxAdjustStep}
                  onChange={(v) => updateSettings((prev) => ({ ...prev, coyoteSafety: { ...prev.coyoteSafety, maxAdjustStep: v } }))}
                />
              </div>
            </section>

            <section className="settings-row-card space-y-3">
              <h3 className="settings-card-legend">负鼠安全上限</h3>
              <div className="grid grid-cols-2 gap-3">
                <NumberField
                  label="A 通道强度上限"
                  value={settings.opossumSafety.maxIntensityA}
                  onChange={(v) => updateSettings((prev) => ({ ...prev, opossumSafety: { ...prev.opossumSafety, maxIntensityA: v } }))}
                />
                <NumberField
                  label="B 通道强度上限"
                  value={settings.opossumSafety.maxIntensityB}
                  onChange={(v) => updateSettings((prev) => ({ ...prev, opossumSafety: { ...prev.opossumSafety, maxIntensityB: v } }))}
                />
              </div>
            </section>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm text-[var(--text-soft)]">{label}</label>
      <Input
        type="number"
        min={0}
        max={200}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
