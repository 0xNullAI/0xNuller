import { SettingLabel } from './setting-label';
import { Switch } from './switch';

interface SettingToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: string;
}

export function SettingToggle({
  checked,
  onCheckedChange,
  label,
  description,
}: SettingToggleProps) {
  return (
    <label className="setting-toggle-row !flex items-center justify-between gap-3 py-1 cursor-pointer">
      <div className="min-w-0">
        <SettingLabel>{label}</SettingLabel>
        {description && (
          <div className="text-xs text-[var(--text-faint)] mt-0.5">{description}</div>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} label={label} />
    </label>
  );
}
