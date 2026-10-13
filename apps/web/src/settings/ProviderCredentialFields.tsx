import { SecretHint } from './SecretHint';
import { Input } from '@0xnullai/ui';
import { isUsableEndpointUrl, onlyHttpsEndpointsAllowed } from '@0xnullai/settings';
import type {
  ProviderDefinition,
  ProviderEndpoint,
  ProviderSettings,
} from '@0xnullai/llm-providers';
import { ProviderFieldControls } from './ProviderFieldControls';

export type ProviderCredentialConfig = ProviderSettings & { rememberApiKey: boolean };

/** Custom endpoints never send images until the user says the model accepts them. */
export function ProviderImageInputToggle<T extends ProviderCredentialConfig>({
  config,
  update,
}: {
  config: T;
  update: (patch: Partial<T>) => void;
}) {
  if (config.providerId !== 'custom') return null;
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-[var(--text-soft)]">
      <span>支持图片输入</span>
      <input
        type="checkbox"
        checked={config.imageInput}
        onChange={(event) => update({ imageInput: event.target.checked } as Partial<T>)}
      />
    </label>
  );
}

export function ProviderCredentialFields<T extends ProviderCredentialConfig>({
  config,
  definition,
  update,
}: {
  config: T;
  definition: ProviderDefinition | undefined;
  update: (patch: Partial<T>) => void;
}) {
  // Managed has no user-editable connection fields; only the custom endpoint does.
  const showAdvanced = config.providerId === 'custom';
  const hasApiKey = definition?.fields.some((field) => field.key === 'apiKey') ?? false;
  return (
    <>
      {showAdvanced ? (
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
      ) : null}
      {showAdvanced && <EndpointSchemeNote baseUrl={config.baseUrl} />}

      {hasApiKey && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">API 密钥</span>
          <Input
            type="password"
            value={config.apiKey}
            onChange={(event) => update({ apiKey: event.target.value } as Partial<T>)}
          />
          <SecretHint value={config.apiKey} />
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

/** The Android shell blocks plain http, so a custom endpoint there must be https. */
function EndpointSchemeNote({ baseUrl }: { baseUrl: string }) {
  if (!onlyHttpsEndpointsAllowed()) return null;
  const blocked = baseUrl.trim().length > 0 && !isUsableEndpointUrl(baseUrl);
  return (
    <p
      role={blocked ? 'alert' : undefined}
      className={`text-xs ${blocked ? 'text-[var(--danger)]' : 'text-[var(--text-faint)]'}`}
    >
      {blocked
        ? '安卓应用只能连接 https:// 开头的接口地址，请更换地址。'
        : '安卓应用只能连接 https:// 开头的接口地址。'}
    </p>
  );
}
