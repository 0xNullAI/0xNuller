import { ArrowLeft, LayoutTemplate, RotateCcw, Settings2, ShieldCheck, Volume2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PresetSelector } from '@/components/PresetSelector';
import type { VoiceSettings } from '@/lib/settings';
import { GeneralTab } from './GeneralTab';
import { VoiceTab } from './VoiceTab';
import { SafetyTab } from './SafetyTab';

export type SettingsTab = 'general' | 'voice' | 'preset' | 'safety';

export const SETTINGS_NAV_ITEMS: Array<{
  value: SettingsTab;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { value: 'general', label: '基础', description: '主题、语音供应商和确认模式', icon: Settings2 },
  { value: 'voice', label: '语音', description: '音色与语速', icon: Volume2 },
  { value: 'preset', label: '场景', description: '内置场景和自定义场景', icon: LayoutTemplate },
  { value: 'safety', label: '安全', description: '强度上限和对话行为', icon: ShieldCheck },
];

export const SETTINGS_NAV_GROUPS: Array<{ label: string; values: SettingsTab[] }> = [
  { label: '配置', values: ['general', 'voice', 'preset'] },
  { label: '安全', values: ['safety'] },
];

const PROJECT_URL = 'https://github.com/0xNullAI/DG-Voice';

interface SettingsPanelProps {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  mobileNavOpen: boolean;
  onMobileNavOpenChange: (open: boolean) => void;
  onClose: () => void;
  onRequestReset: () => void;
  settings: VoiceSettings;
  updateSettings: (updater: (prev: VoiceSettings) => VoiceSettings) => void;
}

function TabContent({
  tab,
  settings,
  updateSettings,
}: Pick<SettingsPanelProps, 'tab' | 'settings' | 'updateSettings'>) {
  switch (tab) {
    case 'general':
      return <GeneralTab settings={settings} updateSettings={updateSettings} />;
    case 'voice':
      return <VoiceTab settings={settings} updateSettings={updateSettings} />;
    case 'preset':
      return (
        <div className="settings-panel-tab-content">
          <PresetSelector settings={settings} updateSettings={updateSettings} />
        </div>
      );
    case 'safety':
      return <SafetyTab settings={settings} updateSettings={updateSettings} />;
    default:
      return null;
  }
}

export function SettingsSidebar({
  tab,
  onTabChange,
  onMobileNavOpenChange,
  onClose,
  onRequestReset,
}: Pick<
  SettingsPanelProps,
  'tab' | 'onTabChange' | 'onMobileNavOpenChange' | 'onClose' | 'onRequestReset'
>) {
  return (
    <aside className="settings-sidebar">
      <button type="button" className="settings-sidebar-back" onClick={onClose}>
        <ArrowLeft className="h-4 w-4" />
        <span>返回通话</span>
      </button>

      <nav className="settings-sidebar-nav" aria-label="设置分类">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <div key={group.label} className="settings-nav-group">
            <div className="settings-nav-group-label">{group.label}</div>
            {group.values.map((value) => {
              const item = SETTINGS_NAV_ITEMS.find((entry) => entry.value === value)!;
              const active = item.value === tab;
              const Icon = item.icon;
              return (
                <button
                  key={item.value}
                  type="button"
                  className={active ? 'settings-nav-item active' : 'settings-nav-item'}
                  onClick={() => {
                    onTabChange(item.value);
                    onMobileNavOpenChange(false);
                  }}
                >
                  <Icon className="settings-nav-icon" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="settings-sidebar-footer">
        <Button variant="ghost" className="settings-sidebar-reset" onClick={onRequestReset}>
          <RotateCcw className="h-4 w-4 shrink-0" />
          <span>恢复默认</span>
        </Button>
        <Button variant="ghost" className="settings-sidebar-reset" asChild>
          <a href={PROJECT_URL} target="_blank" rel="noopener noreferrer" aria-label="项目主页">
            <GitHubMark className="h-4 w-4 shrink-0" />
            <span>项目主页</span>
          </a>
        </Button>
      </div>
    </aside>
  );
}

export function SettingsWorkspace(props: SettingsPanelProps) {
  const { tab, onTabChange, mobileNavOpen, onMobileNavOpenChange, onClose, onRequestReset } = props;
  const currentItem = SETTINGS_NAV_ITEMS.find((item) => item.value === tab) ?? SETTINGS_NAV_ITEMS[0]!;

  return (
    <section className={mobileNavOpen ? 'settings-workspace settings-mobile-nav-open' : 'settings-workspace'}>
      {/* Mobile fullscreen directory */}
      <section className="settings-mobile-directory lg:hidden">
        <header className="settings-mobile-directory-header">
          <button type="button" onClick={onClose} aria-label="返回通话">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2>设置</h2>
          <button type="button" onClick={onClose} aria-label="关闭设置">
            <X className="h-4 w-4" />
          </button>
        </header>
        <nav className="settings-mobile-directory-list" aria-label="设置分类">
          {SETTINGS_NAV_GROUPS.map((group) => (
            <div key={group.label} className="settings-mobile-directory-group">
              <div className="settings-mobile-directory-group-label">{group.label}</div>
              {group.values.map((value) => {
                const item = SETTINGS_NAV_ITEMS.find((entry) => entry.value === value)!;
                const Icon = item.icon;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => {
                      onTabChange(item.value);
                      onMobileNavOpenChange(false);
                    }}
                  >
                    <Icon className="settings-mobile-directory-icon" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="settings-mobile-directory-footer">
          <button type="button" onClick={onRequestReset}>
            <RotateCcw className="h-4 w-4" />
            <span>恢复默认</span>
          </button>
          <a href={PROJECT_URL} target="_blank" rel="noopener noreferrer" aria-label="项目主页">
            <GitHubMark className="h-4 w-4" />
            <span>项目主页</span>
          </a>
        </div>
      </section>

      {/* Mobile top bar */}
      <header className="settings-mobile-header lg:hidden">
        <button type="button" className="settings-mobile-back" onClick={() => onMobileNavOpenChange(true)}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span>{currentItem.label}</span>
        <button type="button" className="settings-mobile-back" onClick={onClose} aria-label="关闭设置">
          <X className="h-4 w-4" />
        </button>
      </header>

      {/* Main content */}
      <main className="settings-workspace-main">
        <header className="settings-workspace-title">
          <h2>{currentItem.label}</h2>
          <p>{currentItem.description}</p>
        </header>
        <div className="settings-workspace-content">
          <div className="settings settings-grouped">
            <TabContent tab={tab} settings={props.settings} updateSettings={props.updateSettings} />
          </div>
        </div>
      </main>
    </section>
  );
}

// GitHub 官方 mark — lucide-react 已移除 Github 图标，这里手写一个 SVG
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.33.95.1-.74.4-1.24.73-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.18a10.92 10.92 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.68.8.56C20.22 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}
