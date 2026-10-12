import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * `undefined`: no page area, so a panel shows its own 高级 section.
 * `null`: the page area is mounting; panels wait one commit for its node.
 */
const AdvancedSlot = createContext<HTMLElement | null | undefined>(undefined);

const SECTION_CLASS = 'space-y-4 border-t border-[var(--surface-border)] pt-4';
const HEADING_CLASS = 'text-sm font-medium text-[var(--text-faint)]';

/**
 * One flat 高级 section at the end of a settings page. Panels on the page keep their own
 * state and render their advanced rows here through `AdvancedSettings`.
 */
export function AdvancedSettingsArea({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <>
      <AdvancedSlot.Provider value={slot}>{children}</AdvancedSlot.Provider>
      <section aria-label="高级" className={SECTION_CLASS}>
        <h3 className={HEADING_CLASS}>高级</h3>
        <div ref={setSlot} className="space-y-4" />
      </section>
    </>
  );
}

/** Advanced rows of one panel. Outside a page area they get their own flat 高级 section. */
export function AdvancedSettings({ children }: { children: ReactNode }) {
  const slot = useContext(AdvancedSlot);
  if (slot === undefined)
    return (
      <section aria-label="高级" className={SECTION_CLASS}>
        <h3 className={HEADING_CLASS}>高级</h3>
        {children}
      </section>
    );
  return slot ? createPortal(children, slot) : null;
}
