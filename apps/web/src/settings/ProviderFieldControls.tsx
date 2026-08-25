import { Input, SettingSelect } from '@0xnullai/ui';

export interface ProviderSettingField {
  key: string;
  label: string;
  type: 'password' | 'text' | 'url' | 'select';
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

/** Shared catalog-driven field rendering for text, realtime and visual providers. */
export function ProviderFieldControls({
  fields,
  getValue,
  onValueChange,
}: {
  fields: readonly ProviderSettingField[];
  getValue: (key: string) => string;
  onValueChange: (key: string, value: string) => void;
}) {
  return fields.map((field) => (
    <label key={field.key} className="flex flex-col gap-1.5">
      <span className="text-xs text-[var(--text-soft)]">{field.label}</span>
      {field.type === 'select' ? (
        <SettingSelect
          value={getValue(field.key)}
          onValueChange={(value) => onValueChange(field.key, value)}
          options={field.options ?? []}
        />
      ) : (
        <Input
          type={field.type}
          value={getValue(field.key)}
          placeholder={field.placeholder}
          onChange={(event) => onValueChange(field.key, event.target.value)}
        />
      )}
    </label>
  ));
}
