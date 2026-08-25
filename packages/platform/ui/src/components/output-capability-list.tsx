import type { UnifiedOutputTarget } from '@0xnullai/device-runtime';

export function OutputCapabilityList({
  targets,
}: {
  targets: readonly Pick<UnifiedOutputTarget, 'id' | 'kind' | 'label' | 'battery' | 'modality'>[];
}) {
  return (
    <section aria-labelledby="output-capabilities-title" className="grid gap-2">
      <h2 id="output-capabilities-title" className="text-xs text-[var(--text-soft)]">
        已连接输出能力
      </h2>
      {targets.length === 0 ? (
        <p className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] p-3 text-xs text-[var(--text-faint)]">
          尚未连接输出设备
        </p>
      ) : (
        <ul className="grid gap-2">
          {targets.map((target) => (
            <li
              key={target.id}
              className="flex items-center gap-2 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2 text-xs"
            >
              <span className="h-2 w-2 rounded-full bg-[var(--success)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{target.label}</span>
              <span className="text-[var(--text-faint)]">
                {target.modality === 'electrostimulation' ? '电刺激' : '振动'}
                {typeof target.battery === 'number' ? ` · ${target.battery}%` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
