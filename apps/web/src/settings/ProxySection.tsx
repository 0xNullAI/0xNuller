import { useEffect, useState } from 'react';
import { Input } from '@0xnullai/ui';
import { loadProxy, subscribeProxy, updateProxy, type ProxySettings } from '@0xnullai/settings';

export function ProxySection() {
  const [proxy, setProxy] = useState<ProxySettings>(loadProxy);

  useEffect(() => subscribeProxy(setProxy), []);

  function patch(p: Partial<ProxySettings>) {
    setProxy(updateProxy((prev) => ({ ...prev, ...p })));
  }

  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm font-semibold">代理设置</span>
        <input
          type="checkbox"
          checked={proxy.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="accent-[var(--accent)]"
        />
      </label>

      {proxy.enabled && (
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">反向代理地址</span>
            <Input
              value={proxy.httpBaseUrl}
              onChange={(e) => patch({ httpBaseUrl: e.target.value })}
              placeholder="http://127.0.0.1:8080"
            />
          </label>
        </div>
      )}
    </section>
  );
}
