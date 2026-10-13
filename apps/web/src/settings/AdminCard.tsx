import type { ReactNode } from 'react';

/** One bordered block on the admin page: a short title, optional actions, then content. */
export function AdminCard({
  title,
  actions,
  children,
  label,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section
      aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-soft)] p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
