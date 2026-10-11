import { useEffect, useState } from 'react';
import { Input } from '@0xnullai/ui';
import { SettingsGroup, SettingsPage, SwitchRow } from './settings-list';
import {
  isValidHttpProxyBaseUrl,
  loadProxy,
  subscribeProxy,
  updateProxy,
  type ProxySettings,
} from '@0xnullai/settings';

export function ProxySection() {
  const [proxy, setProxy] = useState<ProxySettings>(loadProxy);

  useEffect(() => subscribeProxy(setProxy), []);

  function patch(p: Partial<ProxySettings>) {
    setProxy(updateProxy((prev) => ({ ...prev, ...p })));
  }

  const validUrl = isValidHttpProxyBaseUrl(proxy.httpBaseUrl);

  return (
    <SettingsPage>
      <SettingsGroup
        label="代理地址"
        footer={
          proxy.httpBaseUrl.length > 0 && !validUrl ? (
            <span role="alert" className="text-[var(--danger)]">
              请输入有效的 HTTP 或 HTTPS 地址
            </span>
          ) : (
            'AI 请求经此反向代理转发，仅本设备生效。'
          )
        }
      >
        <div className="px-4 py-3">
          <Input
            aria-label="反向代理地址"
            value={proxy.httpBaseUrl}
            onChange={(event) => {
              const httpBaseUrl = event.target.value;
              patch({
                httpBaseUrl,
                ...(proxy.enabled && !isValidHttpProxyBaseUrl(httpBaseUrl)
                  ? { enabled: false }
                  : {}),
              });
            }}
            placeholder="http://127.0.0.1:8080"
            aria-invalid={proxy.httpBaseUrl.length > 0 && !validUrl}
          />
        </div>
      </SettingsGroup>
      <SettingsGroup>
        <SwitchRow
          label="启用网络代理"
          checked={proxy.enabled}
          disabled={!proxy.enabled && !validUrl}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
