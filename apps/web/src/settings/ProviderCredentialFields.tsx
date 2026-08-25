import { Input } from '@0xnullai/ui';
import type {
  ProviderDefinition,
  ProviderEndpoint,
  ProviderSettings,
} from '@0xnullai/llm-providers';
import { ProviderFieldControls } from './ProviderFieldControls';

export type ProviderCredentialConfig = ProviderSettings & { rememberApiKey: boolean };

export function ProviderCredentialFields<T extends ProviderCredentialConfig>({
  config,
  definition,
  update,
}: {
  config: T;
  definition: ProviderDefinition | undefined;
  update: (patch: Partial<T>) => void;
}) {
  const hasApiKey = definition?.fields.some((field) => field.key === 'apiKey') ?? false;
  return (
    <>
      <ProviderFieldControls
        fields={
          definition?.fields.filter((field) => field.key !== 'model' && field.key !== 'apiKey') ??
          []
        }
        getValue={(key) => String(config[key as 'baseUrl' | 'endpoint' | 'useStrict'] ?? '')}
        onValueChange={(key, value) =>
          update(
            (key === 'useStrict'
              ? { useStrict: value === 'true' }
              : key === 'endpoint'
                ? { endpoint: value as ProviderEndpoint }
                : { [key]: value }) as Partial<T>,
          )
        }
      />

      {hasApiKey && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">API 密钥</span>
          <Input
            type="password"
            value={config.apiKey}
            onChange={(event) => update({ apiKey: event.target.value } as Partial<T>)}
          />
        </label>
      )}
    </>
  );
}

export function ProviderRememberApiKey<T extends ProviderCredentialConfig>({
  config,
  definition,
  label,
  update,
}: {
  config: T;
  definition: ProviderDefinition | undefined;
  label: string;
  update: (patch: Partial<T>) => void;
}) {
  if (!definition?.fields.some((field) => field.key === 'apiKey')) return null;
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-[var(--text-soft)]">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={config.rememberApiKey}
        onChange={(event) => update({ rememberApiKey: event.target.checked } as Partial<T>)}
      />
    </label>
  );
}
