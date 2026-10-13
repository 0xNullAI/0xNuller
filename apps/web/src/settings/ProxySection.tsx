import { useEffect, useState } from 'react';
import { Input } from '@0xnullai/ui';
import { SettingsGroup, SwitchRow } from './settings-list';
import {
  isUsableEndpointUrl,
  loadProxy,
  onlyHttpsEndpointsAllowed,
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

  const httpsOnly = onlyHttpsEndpointsAllowed();
  const validUrl = isUsableEndpointUrl(proxy.httpBaseUrl);

  return (
    <SettingsGroup
      label="网络代理"
      footer={
        proxy.httpBaseUrl.length > 0 && !validUrl ? (
          <span role="alert" className="text-[var(--danger)]">
            {httpsOnly
              ? '安卓应用只能使用 https:// 开头的代理地址'
              : '请输入有效的 HTTP 或 HTTPS 地址'}
          </span>
        ) : (
          `开启后，AI 请求经这个反向代理地址转发，仅本设备生效。先填地址，再打开开关。${
            httpsOnly ? '安卓应用只能使用 https 地址。' : ''
          }`
        )
      }
    >
      <SwitchRow
        label="启用网络代理"
        checked={proxy.enabled}
        disabled={!proxy.enabled && !validUrl}
        onCheckedChange={(enabled) => patch({ enabled })}
      />
      <div className="flex flex-col gap-1.5 px-4 py-3">
        <span className="text-xs text-[var(--text-soft)]">代理地址</span>
        <Input
          aria-label="反向代理地址"
          value={proxy.httpBaseUrl}
          onChange={(event) => {
            const httpBaseUrl = event.target.value;
            patch({
              httpBaseUrl,
              ...(proxy.enabled && !isUsableEndpointUrl(httpBaseUrl) ? { enabled: false } : {}),
            });
          }}
          placeholder={httpsOnly ? 'https://proxy.example.com' : 'http://127.0.0.1:8080'}
          aria-invalid={proxy.httpBaseUrl.length > 0 && !validUrl}
        />
      </div>
    </SettingsGroup>
  );
}
