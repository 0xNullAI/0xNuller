import { useState } from 'react';
import { Cpu, Palette, ShieldAlert, X } from 'lucide-react';
import { Overlay } from '@0xnullai/ui';
import { AppearanceTab } from './AppearanceTab';
import { AiTab } from './AiTab';
import { SafetyTab } from './SafetyTab';

/**
 * 全软件唯一的设置面板。
 *
 * 合并前每个模块各有一套设置界面（Agent 六个标签页、Voice 四个、Chat 一个 AI 对话框），
 * 同一件事在三处能改，改哪一处生效取决于当时开着哪个模块。现在只有这一个入口，
 * 从侧边栏底部的账户菜单进。
 *
 * 三个分区，边界按「改了之后影响什么」划：
 * - **外观**：只影响这台设备上的显示。
 * - **AI**：影响模型怎么理解你，跨模块共用同一份 provider 配置。
 * - **设备安全**：影响设备输出到人体上的电流。全应用共享一份，切换模块不会变。
 */

const TABS = [
  { id: 'appearance', label: '外观', icon: Palette, Component: AppearanceTab },
  { id: 'ai', label: 'AI', icon: Cpu, Component: AiTab },
  { id: 'safety', label: '设备安全', icon: ShieldAlert, Component: SafetyTab },
] as const;

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('appearance');
  const Active = TABS.find((t) => t.id === tab)!.Component;

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="flex h-[min(680px,calc(100vh-2rem))] w-[min(880px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[20px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-panel)] sm:flex-row"
      >
        {/* 窄屏：标签横排在顶部。竖排的导航列在手机上会吃掉一半宽度。 */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--surface-border)] p-2 sm:w-[180px] sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
          <h2 className="hidden px-2 pb-2 pt-1 text-sm font-semibold sm:block">设置</h2>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={
                'flex shrink-0 items-center gap-2 rounded-[10px] px-3 py-2 text-sm transition-colors ' +
                (tab === t.id
                  ? 'bg-[var(--accent-soft)] font-medium text-[var(--text)]'
                  : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]')
              }
            >
              <t.icon className="h-4 w-4 shrink-0" />
              {t.label}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-end p-2">
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭设置"
              className="rounded-[10px] p-2 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            <Active />
          </div>
        </div>
      </div>
    </Overlay>
  );
}
