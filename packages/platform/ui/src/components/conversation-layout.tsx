import { useState, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../utils';
import { conversationTailArrivals, formatConversationTime } from './conversation-sequence';

/** Presentation only: transport, permission, recording and stop owners remain in the feature. */
export function ConversationHeader({ children, className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      {...props}
      data-conversation-header
      className={cn(
        'flex h-14 min-w-0 shrink-0 items-center gap-1.5 border-b border-[var(--surface-border)] bg-[var(--bg)] px-2 sm:gap-2 sm:px-4',
        className,
      )}
    >
      {children}
    </header>
  );
}

/** The conversation name in the header: one line, 17px/600, never a subtitle below it. */
export function ConversationTitle({ children, className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      {...props}
      className={cn(
        'min-w-0 truncate text-[length:var(--text-topbar-title)] font-semibold text-[var(--text)]',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ConversationTimeline({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      data-conversation-timeline
      className={cn(
        'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-3 [scrollbar-gutter:stable] sm:px-6',
        className,
      )}
    >
      {/* 12px between sender groups; a continued row pulls itself up to a 2px gap. */}
      <div className="mx-auto flex min-h-full w-full max-w-[800px] flex-col justify-end gap-3 pb-4">
        {children}
      </div>
    </div>
  );
}

export function ConversationComposer({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      data-conversation-composer
      className={cn(
        'relative mx-auto flex w-full min-w-0 max-w-[800px] shrink-0 flex-col gap-1.5 border-t border-[var(--surface-border)] bg-[var(--bg)] px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Centered faint time between messages; shown by `conversationSequence`, not under bubbles. */
export function ConversationTimeSeparator({ at, now }: { at: number; now?: number }) {
  return (
    <p data-conversation-time className="py-1 text-center text-xs text-[var(--text-faint)]">
      <time dateTime={new Date(at).toISOString()} className="tabular-nums">
        {formatConversationTime(at, now)}
      </time>
    </p>
  );
}

/** A small centered system note (tool trace, camera, a failed reply). */
export function ConversationSystemRow({
  children,
  tone = 'default',
  className,
  ...props
}: ComponentProps<'div'> & { tone?: 'default' | 'danger' }) {
  return (
    <div {...props} className={cn('flex justify-center px-6', className)}>
      <div
        className={cn(
          'max-w-[min(90%,480px)] rounded-[var(--radius-sm)] px-3 py-1.5 text-center text-[13px] leading-snug',
          tone === 'danger'
            ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
            : 'bg-[var(--bg-strong)] text-[var(--text-soft)]',
        )}
      >
        {children}
      </div>
    </div>
  );
}

interface ConversationMessageRowProps extends ComponentProps<'div'> {
  own: boolean;
  /** Same sender as the row above: 2px gap instead of 12px. */
  continued?: boolean;
  /** Last row of the sender group. Only this row shows the avatar. */
  groupEnd?: boolean;
  /** A message that arrived while the conversation was open. Never set on history. */
  arrived?: boolean;
  avatar?: ReactNode;
  contentClassName?: string;
}

/** Shared message alignment only; each chat owns its sender identity, media and actions. */
export function ConversationMessageRow({
  own,
  continued = false,
  groupEnd = true,
  arrived = false,
  avatar,
  contentClassName,
  className,
  children,
  ...props
}: ConversationMessageRowProps) {
  return (
    <div
      {...props}
      data-conversation-message
      data-own={own || undefined}
      data-continued={continued || undefined}
      className={cn(
        'flex min-w-0 items-end gap-2',
        continued && '-mt-2.5',
        own ? 'justify-end' : 'justify-start',
        arrived && 'ui-fade-up',
        className,
      )}
    >
      {avatar !== undefined && (
        <div className="w-7 shrink-0" aria-hidden={!groupEnd || undefined}>
          {groupEnd && avatar}
        </div>
      )}
      <div
        className={cn('flex min-w-0 max-w-[78%] flex-col', own && 'items-end', contentClassName)}
      >
        {children}
      </div>
    </div>
  );
}

/** 18px bubble with a 6px corner on the speaker side. Own = accent, other = elevated surface. */
export function conversationBubbleClass(
  own: boolean,
  mentioned = false,
  continued = false,
): string {
  return cn(
    'min-w-0 overflow-hidden break-words [overflow-wrap:anywhere] rounded-[18px] px-3.5 py-2 text-[15px] leading-[1.45]',
    own
      ? cn(
          'rounded-br-[6px] bg-[var(--accent)] text-[var(--button-text)]',
          continued && 'rounded-tr-[6px]',
        )
      : cn(
          'rounded-bl-[6px] border text-[var(--text)]',
          continued && 'rounded-tl-[6px]',
          mentioned
            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
            : 'border-[var(--surface-border)] bg-[var(--bg-elevated)]',
        ),
  );
}

/** Three-dot typing indicator in an incoming bubble. The only looping chat animation. */
export function ConversationTyping({ avatar }: { avatar?: ReactNode }) {
  return (
    <div className="ui-fade-up flex min-w-0 items-end gap-2" role="status" aria-label="正在输入">
      {avatar !== undefined && <div className="w-7 shrink-0">{avatar}</div>}
      <div className="inline-flex items-center gap-1 rounded-[18px] rounded-bl-[6px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-faint)] motion-safe:animate-pulse" />
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-faint)] motion-safe:animate-pulse [animation-delay:120ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-faint)] motion-safe:animate-pulse [animation-delay:240ms]" />
      </div>
    </div>
  );
}

export function ConversationEmpty({ children = '发条消息，开始聊天' }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-32 flex-1 items-center justify-center px-4 text-center text-sm text-[var(--text-faint)]">
      {children}
    </div>
  );
}

// The textarea and its invisible sizer share every metric, so the sizer's height is the
// text's height. Five lines of 22px plus 2 × 10px padding plus the border.
const INPUT_METRICS =
  'col-start-1 row-start-1 min-h-11 max-h-[132px] w-full rounded-[22px] border px-4 py-[10px] text-base leading-[22px] break-words [overflow-wrap:anywhere]';

/**
 * Pill text input that grows with its text up to five lines, then scrolls. CSS only: an
 * invisible copy of the value sizes the grid cell and the textarea fills it.
 */
export function ConversationInput({
  className,
  value,
  rows = 1,
  ...props
}: Omit<ComponentProps<'textarea'>, 'value'> & { value: string }) {
  return (
    <div className={cn('grid min-w-0 flex-1', className)}>
      <span
        aria-hidden
        className={cn(
          INPUT_METRICS,
          'invisible overflow-hidden whitespace-pre-wrap border-transparent',
        )}
      >
        {`${value} `}
      </span>
      <textarea
        {...props}
        rows={rows}
        value={value}
        className={cn(
          INPUT_METRICS,
          'resize-none overflow-y-auto border-[var(--surface-border)] bg-[var(--bg-elevated)] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] disabled:opacity-60',
        )}
      />
    </div>
  );
}

/** Round composer button. `ready` turns it accent: send is possible now. */
export function conversationComposerButtonClass(ready = false): string {
  return cn(
    'ui-press flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-40',
    ready
      ? 'bg-[var(--accent)] text-[var(--button-text)]'
      : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]',
  );
}

/**
 * Ids that arrived at the end of the list while this conversation was open: those rows get
 * `arrived` (the fade-up). The first list, a conversation switch and older history do not
 * count. While `holding` is true (a streaming draft is on screen), the next arrival replaces
 * the draft in place and is not animated again.
 */
export function useConversationArrivals(
  ids: readonly string[],
  holding = false,
): ReadonlySet<string> {
  const key = ids.join('\u0000');
  const [state, setState] = useState(() => ({
    key,
    ids,
    holding,
    arrivals: new Set<string>() as ReadonlySet<string>,
  }));
  if (state.key === key) {
    if (state.holding !== holding) setState({ ...state, holding });
    return state.arrivals;
  }
  const present = new Set(ids);
  const arrivals = new Set([...state.arrivals].filter((id) => present.has(id)));
  if (!state.holding) for (const id of conversationTailArrivals(state.ids, ids)) arrivals.add(id);
  setState({ key, ids, holding, arrivals });
  return arrivals;
}
