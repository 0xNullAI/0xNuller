import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useSettingsSubpage } from '@0xnullai/ui';

/**
 * The one "高级" pattern for settings pages: a page shows its few core rows, then this
 * last row opens one flat sub-page. The sub-page title and back arrow live in the
 * settings panel header, so the screen never stacks a second back row or collapsible
 * layers on top of the page.
 */
export function AdvancedEntryRow({
  onOpen,
  label = '高级',
}: {
  onOpen: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-12 w-full items-center gap-3 rounded-2xl bg-[var(--bg-elevated)] px-4 text-left text-sm hover:bg-[var(--bg-soft)]"
    >
      <span className="min-w-0 flex-1">{label}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
    </button>
  );
}

export function AdvancedSubpage({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  // The header registration depends on the handler's identity; keep it stable so an inline
  // arrow from the caller cannot make the header re-register on every render.
  const backRef = useRef(onBack);
  useEffect(() => {
    backRef.current = onBack;
  });
  const stableBack = useCallback(() => backRef.current(), []);
  const sharedHeader = useSettingsSubpage({ title, onBack: stableBack });
  const focusHeading = useCallback((node: HTMLHeadingElement | null) => node?.focus(), []);
  return (
    <section aria-label={title} className="flex flex-col gap-6">
      {sharedHeader ? (
        // The settings panel header already shows this title and its back arrow.
        <h3 tabIndex={-1} ref={focusHeading} className="sr-only">
          {title}
        </h3>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={stableBack}
            aria-label="返回上一页"
            className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-[var(--bg-soft)]"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h3 tabIndex={-1} ref={focusHeading} className="text-base font-semibold outline-none">
            {title}
          </h3>
        </div>
      )}
      {children}
    </section>
  );
}

/** A plain heading for one group inside a flat 高级 page. */
export function AdvancedSection({
  id,
  title,
  note,
  children,
}: {
  id?: string;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-label={title} className="flex flex-col gap-3">
      <div>
        <h4 className="text-sm font-semibold">{title}</h4>
        {note ? <p className="mt-1 text-xs text-[var(--text-faint)]">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}
