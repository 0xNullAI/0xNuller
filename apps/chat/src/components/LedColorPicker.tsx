import { Lightbulb } from 'lucide-react';

interface LedColorPickerProps {
  /** What the device actually supports is a discrete 8-color enum (0-7), not RGB / a continuous
   *  byte — each button swatch is the real color the device lights up with. The enum values come
   *  from the community Bluetooth protocol docs (the paw-prints color table + the civet
   *  "01=黄色" example). */
  onPick: (colorByte: number) => void;
  disabled?: boolean;
  className?: string;
}

const PRESETS: Array<{ label: string; byte: number; swatch: string }> = [
  { label: '熄灭', byte: 0, swatch: '#4b5563' },
  { label: '黄', byte: 1, swatch: '#eab308' },
  { label: '红', byte: 2, swatch: '#ef4444' },
  { label: '紫', byte: 3, swatch: '#a855f7' },
  { label: '蓝', byte: 4, swatch: '#3b82f6' },
  { label: '青', byte: 5, swatch: '#06b6d4' },
  { label: '绿', byte: 6, swatch: '#22c55e' },
  { label: '白', byte: 7, swatch: '#e5e7eb' },
];

/**
 * Small reusable LED color picker, shared by the paw-prints / civet-edging / opossum devices.
 * A click hands the color enum value (0-7) straight to the caller through onPick — the caller
 * is responsible for sending it with the 'set_led' room action (own and remote devices both go
 * down the same path, see MemberControl).
 */
export function LedColorPicker({ onPick, disabled, className }: LedColorPickerProps) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center gap-1 text-[11px] text-[var(--text-faint)]">
        <Lightbulb size={12} /> 灯光颜色
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.byte}
            disabled={disabled}
            onClick={() => onPick(preset.byte)}
            title={`${preset.label}（字节值 ${preset.byte}）`}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--surface-border)] transition-transform hover:scale-110 active:scale-95 disabled:opacity-30 disabled:hover:scale-100"
            style={{ backgroundColor: preset.swatch }}
          >
            <span className="sr-only">{preset.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
