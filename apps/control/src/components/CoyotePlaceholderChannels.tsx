const RING_CLASS =
  'flex h-24 w-24 flex-col items-center justify-center gap-0.5 rounded-full border-[3px] border-[var(--surface-border)] bg-[var(--bg-elevated)]';

const BUTTON_CLASS =
  'flex h-10 w-10 items-center justify-center rounded-full border-2 border-[var(--surface-border)] bg-[var(--bg-elevated)] text-xl font-medium text-[var(--text)]';

/** The legacy nothing-attached stand-in: two familiar Coyote rings, kept inert. */
export function CoyotePlaceholderChannels() {
  return (
    <div className="flex items-center justify-center gap-6 opacity-40">
      {(['A', 'B'] as const).map((channel) => (
        <div key={channel} className="flex flex-col items-center">
          <div className="mb-2 h-9 w-9 rounded-full bg-[var(--bg-soft)]" />
          <div className={RING_CLASS}>
            <span className="text-2xl font-bold tabular-nums text-[var(--text)]">0</span>
            <span className="text-[10px] text-[var(--text-faint)]">{channel}</span>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className={BUTTON_CLASS}>−</span>
            <span className={BUTTON_CLASS}>+</span>
          </div>
        </div>
      ))}
    </div>
  );
}
