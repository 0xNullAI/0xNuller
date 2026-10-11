import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../utils';

/** Presentation only: transport, permission, recording and stop owners remain in the feature. */
export function ConversationHeader({ children, className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      {...props}
      data-conversation-header
      className={cn(
        'flex min-h-16 min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--surface-border)] bg-[var(--bg)] px-3 py-2 sm:gap-3 sm:px-5',
        className,
      )}
    >
      {children}
    </header>
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
        'relative mx-auto flex w-full min-w-0 max-w-[800px] shrink-0 flex-col gap-2 border-t border-[var(--surface-border)] bg-[var(--bg)] px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

interface ConversationMessageRowProps extends ComponentProps<'div'> {
  own: boolean;
  grouped?: boolean;
  avatar?: ReactNode;
  contentClassName?: string;
}

/** Shared message alignment only; each chat owns its sender identity, media and actions. */
export function ConversationMessageRow({
  own,
  grouped = false,
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
      className={cn(
        'flex min-w-0 animate-msg-in gap-2',
        grouped ? 'mb-0.5' : 'mb-2',
        own ? 'justify-end' : 'justify-start',
        className,
      )}
    >
      {avatar !== undefined && (
        <div className="w-7 shrink-0" aria-hidden={grouped || undefined}>
          {!grouped && avatar}
        </div>
      )}
      <div className={cn('min-w-0 max-w-[min(85%,560px)]', contentClassName)}>{children}</div>
    </div>
  );
}

export function conversationBubbleClass(own: boolean, mentioned = false): string {
  return cn(
    'min-w-0 overflow-hidden break-words [overflow-wrap:anywhere] rounded-[var(--radius-md)] px-4 py-3 text-[14.5px] leading-[1.6]',
    own
      ? 'rounded-br-[var(--radius-2xs)] bg-[var(--accent)] text-[var(--button-text)]'
      : cn(
          'rounded-bl-[var(--radius-2xs)] border text-[var(--text)]',
          mentioned
            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
            : 'border-[var(--surface-border)] bg-[var(--bg-elevated)]',
        ),
  );
}
export function ConversationEmpty({ children = '发条消息，开始聊天' }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-32 flex-1 items-center justify-center px-4 text-center text-sm text-[var(--text-faint)]">
      {children}
    </div>
  );
}

export function ConversationInput({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={cn(
        'h-11 min-w-0 flex-1 rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 text-base text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] disabled:opacity-60',
        className,
      )}
    />
  );
}
