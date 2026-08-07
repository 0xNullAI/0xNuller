import { Lightbulb } from 'lucide-react';

interface LedColorPickerProps {
  /** 设备实际支持的是离散 8 色枚举（0-7），不是 RGB/连续字节 —— 按钮色块就是设备真实发光颜色，
   *  枚举取值参考社区蓝牙协议文档（爪印色表 + 灵猫 "01=黄色" 示例）。 */
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
 * 小型可复用 LED 颜色选择器，供 paw-prints / civet-edging / opossum 三种设备共用。
 * 点击直接通过 onPick 把颜色枚举值（0-7）交给调用方 —— 调用方负责用 'set_led'
 * room action 把它发出去（自己/远端设备都走同一条路径，见 MemberControl）。
 */
export function LedColorPicker({ onPick, disabled, className }: LedColorPickerProps) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center gap-1 text-[11px] text-[var(--text-faint)]">
        <Lightbulb size={12} /> 灯光颜色
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map(preset => (
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
