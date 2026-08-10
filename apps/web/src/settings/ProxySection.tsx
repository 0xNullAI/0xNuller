import { useEffect, useState } from 'react';
import { Input } from '@0xnullai/ui';
import { loadProxy, subscribeProxy, updateProxy, type ProxySettings } from '@0xnullai/settings';

/**
 * Proxy.
 *
 * Browsers do not let a page pick its own proxy — that is an OS- or
 * browser-level setting. All this can do is point requests at your own HTTP
 * reverse proxy.
 *
 * The scope note is deliberately narrow. It used to read "影响全部模型请求
 * （文本与语音）", but applyHttpProxy has exactly one consumer — the text
 * LLM client — and voice realtime opens its socket directly. Someone turning
 * this on for privacy was told their voice traffic was covered when it was
 * being sent straight out.
 *
 * The SOCKS field is gone for the same reason: nothing read `socksUrl` on
 * any platform, including the Tauri side, while the helper text claimed the
 * native network stack used it. The key stays in the stored settings so
 * existing saved blobs still validate.
 */
export function ProxySection() {
  const [proxy, setProxy] = useState<ProxySettings>(loadProxy);

  useEffect(() => subscribeProxy(setProxy), []);

  function patch(p: Partial<ProxySettings>) {
    setProxy(updateProxy((prev) => ({ ...prev, ...p })));
  }

  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm font-semibold">文本模型代理</span>
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
            <span className="text-xs text-[var(--text-soft)]">HTTP 反代地址</span>
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
