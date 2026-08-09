import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SAFETY_CALLOUT,
  SAFETY_CALLOUTS,
  SAFETY_NOTICE_COUNTDOWN_SECONDS,
  SAFETY_NOTICE_SECTIONS,
} from '@dg-kit/safety';
import { Overlay } from './overlay-surface';
import { Button } from './button';
import { Checkbox } from './checkbox';

/**
 * Pre-use safety acknowledgement. The system's only copy.
 *
 * Pre-merge Agent and Chat each had an implementation (one CSS module, one
 * Tailwind); seven of the nine body items were identical and two had
 * diverged. The body now lives in `@dg-kit/safety`, displayed here, once.
 *
 * Two properties that must not change:
 * - The button is unclickable until the countdown ends. Forced reading,
 *   not decoration.
 * - The backdrop cannot dismiss. Confirmation must be explicit — hence no
 *   onDismiss on the Overlay.
 */

export interface SafetyNoticeProps {
  /** Picks the top callout's wording. Unknown ids fall back to the generic one. */
  moduleId?: string;
  onAccept: (options: { dontShowAgain: boolean }) => void;
  /**
   * The user chose "not now". The exit only shows when this is provided.
   *
   * The notice appears right after a device connects, so there must be a
   * way out that is not acceptance — a lone "I have read this" button
   * forces users to click through to use the UI at all, training them to
   * treat the notice as a meaningless gate.
   */
  onDecline?: () => void;
  /** Override the forced reading seconds. Tests only. */
  countdownSeconds?: number;
}

export function SafetyNotice({
  moduleId,
  onAccept,
  onDecline,
  countdownSeconds = SAFETY_NOTICE_COUNTDOWN_SECONDS,
}: SafetyNoticeProps) {
  const [remaining, setRemaining] = useState(countdownSeconds);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const callout = (moduleId && SAFETY_CALLOUTS[moduleId]) || DEFAULT_SAFETY_CALLOUT;

  useEffect(() => {
    if (remaining === 0) {
      acceptRef.current?.focus();
      return;
    }
    const timer = window.setTimeout(() => setRemaining((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  return (
    // No onDismiss: the backdrop cannot close it; confirmation must be
    // explicit.
    <Overlay scrim="strong">
      <article
        role="dialog"
        aria-modal="true"
        aria-labelledby="safety-notice-title"
        className="max-h-[90vh] w-full max-w-[960px] overflow-auto rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-panel)] sm:p-6"
      >
        <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--accent)]">
          安全确认
        </span>
        <h2 id="safety-notice-title" className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">
          使用前安全确认
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--text-soft)]">
          继续之前，请确认你已经理解设备控制以及运行环境带来的风险，并能够随时主动停止。
        </p>

        <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--warning-border)] bg-[var(--warning-soft)] p-4">
          <p className="text-sm font-semibold">{callout.title}</p>
          <p className="mt-1 text-sm text-[var(--text-soft)]">{callout.body}</p>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {SAFETY_NOTICE_SECTIONS.map((section) => (
            <section
              key={section.title}
              className="rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg)] p-4"
            >
              <h3 className="text-sm font-semibold">{section.title}</h3>
              <ul className="mt-3 space-y-2.5">
                {section.items.map((item, i) => (
                  <li
                    key={item}
                    className="flex items-start gap-2.5 text-sm leading-relaxed text-[var(--text-soft)]"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-[11px] font-bold text-[var(--text)]">
                      {i + 1}
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="mt-5 flex flex-col gap-3 border-t border-[var(--surface-border)] pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--text-soft)]">
              继续即表示你已阅读并愿意自行承担使用风险。
            </p>
            <label className="mt-2 flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={dontShowAgain}
                onCheckedChange={(checked) => setDontShowAgain(Boolean(checked))}
              />
              <span className="text-sm text-[var(--text-soft)]">
                下次启动时不再弹出这条安全确认
              </span>
            </label>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onDecline && (
              <Button variant="secondary" onClick={onDecline}>
                暂不使用
              </Button>
            )}
            <Button
              ref={acceptRef}
              disabled={remaining > 0}
              onClick={() => onAccept({ dontShowAgain })}
            >
              {remaining > 0 ? `我已阅读（${remaining}s）` : '我已阅读并继续'}
            </Button>
          </div>
        </footer>
      </article>
    </Overlay>
  );
}
