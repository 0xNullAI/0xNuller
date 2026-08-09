import { useState, type CSSProperties } from 'react';
import { Cpu, LayoutTemplate, Palette, ShieldAlert, X } from 'lucide-react';
import { ModuleSettingsSlot, Overlay, useModuleSettingsClaims } from '@0xnullai/ui';
import { AppearanceTab } from './AppearanceTab';
import { AiTab } from './AiTab';
import { SafetyTab } from './SafetyTab';
import { ScenesTab } from './ScenesTab';

/**
 * The software's one and only settings panel.
 *
 * Before the merge every module had its own settings UI (Agent six tabs, Voice four,
 * Chat a single AI dialog); the same thing could be changed in three places, and
 * which one took effect depended on which module happened to be open. Now there is
 * only this one entry point, reached from the account menu at the bottom of the
 * sidebar.
 *
 * Four sections, divided along "what does changing it affect":
 * - **Appearance**: only affects the display on this device.
 * - **AI**: affects how the model understands you; one provider config shared across
 *   modules (one set for text, one for voice).
 * - **Scenes**: the persona library, the same set shared by Agent and Voice.
 * - **Device safety**: affects the current the device outputs into a human body. One
 *   copy shared by the whole app; switching modules does not change it.
 */

const TABS = [
  { id: 'appearance', label: '外观', icon: Palette, Component: AppearanceTab },
  { id: 'ai', label: 'AI', icon: Cpu, Component: AiTab },
  { id: 'scenes', label: '场景', icon: LayoutTemplate, Component: ScenesTab },
  { id: 'safety', label: '设备安全', icon: ShieldAlert, Component: SafetyTab },
] as const;

export function SettingsPanel({
  initialTab = 'appearance',
  onClose,
}: {
  /** Which page to land on when opened. Settings entry points inside modules (e.g. the Chat host configuring AI) point straight at the matching page. */
  initialTab?: (typeof TABS)[number]['id'];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<string>(initialTab);
  // Pages declared by whichever modules are mounted. They are settings like
  // any other and belong in this panel, but they read module state the shell
  // does not have, so the module declares the page and the shell places it.
  const moduleClaims = useModuleSettingsClaims();
  const Active = TABS.find((t) => t.id === tab)?.Component;
  const activeModuleClaim = moduleClaims.find((c) => c.id === tab);
  // A module can unmount while its page is open — fall back rather than
  // leaving the content area blank with a nav item selected.
  const resolvedTab = Active || activeModuleClaim ? tab : TABS[0].id;

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="flex h-[min(680px,calc(100vh-2rem))] w-[min(880px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[20px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-panel)] sm:flex-row"
        // Section headings need this color to cover the card border. This is a dialog,
        // laid over --bg-elevated; without declaring it, the heading paints with the
        // default --bg and a darker block shows through in the dark theme.
        style={{ '--settings-surface': 'var(--bg-elevated)' } as CSSProperties}
      >
        {/* Narrow screens: the tabs run horizontally along the top. A vertical nav
            column eats half the width on a phone. */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--surface-border)] p-2 sm:w-[180px] sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
          <h2 className="hidden px-2 pb-2 pt-1 text-sm font-semibold sm:block">设置</h2>
          {[
            ...TABS.map((t) => ({ id: t.id as string, label: t.label, icon: t.icon })),
            ...moduleClaims.map((c) => ({ id: c.id, label: c.label, icon: c.icon })),
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={resolvedTab === t.id ? 'page' : undefined}
              className={
                'flex shrink-0 items-center gap-2 rounded-[10px] px-3 py-2 text-sm transition-colors ' +
                (resolvedTab === t.id
                  ? 'bg-[var(--accent-soft)] font-medium text-[var(--text)]'
                  : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]')
              }
            >
              {t.icon ? <t.icon className="h-4 w-4 shrink-0" /> : null}
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
          {/* The top padding is not optional: section headings ride the card border via
              translateY(-50%), and get clipped in half when flush against the top edge
              of the scroll container. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-3">
            {Active ? <Active /> : null}
            {/* Every module page keeps a mounted slot, not just the active one:
                the slot is the portal target, and a module that renders its
                section before you open its page needs somewhere to land. Only
                the active one is visible. */}
            {moduleClaims.map((claim) => (
              <div key={claim.id} hidden={resolvedTab !== claim.id}>
                <ModuleSettingsSlot id={claim.id} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Overlay>
  );
}
