import { Unplug } from 'lucide-react';
import type { UnifiedOutputTarget } from '@0xnullai/device-runtime';
import { Button } from './button';

export interface OutputTargetPickerProps {
  targets: readonly Pick<UnifiedOutputTarget, 'id' | 'kind' | 'label' | 'battery' | 'active'>[];
  selectedId: string;
  onSelect: (targetId: string) => void;
  onDisconnect?: (targetId: string) => void | Promise<void>;
  label?: string;
  disabled?: boolean;
}

/**
 * Shared output identity selector. Device connection and authorization stay in
 * the owning module; this component only projects the same target list and
 * exact selected identity across Control, Video and future device surfaces.
 */
export function OutputTargetPicker({
  targets,
  selectedId,
  onSelect,
  onDisconnect,
  label = '输出设备',
  disabled = false,
}: OutputTargetPickerProps) {
  const selected = targets.find((target) => target.id === selectedId) ?? null;
  return (
    <div className="flex items-end gap-2">
      <label className="grid min-w-0 flex-1 gap-1 text-xs text-[var(--text-soft)]">
        {label}
        <select
          value={selected?.id ?? ''}
          disabled={disabled || targets.length === 0}
          onChange={(event) => onSelect(event.target.value)}
          className="min-w-0 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2"
        >
          {targets.length === 0 && <option value="">暂无已连接输出</option>}
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.label}
              {typeof target.battery === 'number' ? ` · ${Math.round(target.battery)}%` : ''}
              {target.active ? ' · 输出中' : ''}
            </option>
          ))}
        </select>
      </label>
      {onDisconnect && selected && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => void onDisconnect(selected.id)}
          aria-label={`断开 ${selected.label}`}
        >
          <Unplug aria-hidden="true" className="h-3.5 w-3.5" />
          断开
        </Button>
      )}
    </div>
  );
}
