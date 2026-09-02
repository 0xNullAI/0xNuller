import { useState } from 'react';
import { useEmbeddedDeviceRuntimeEnabled, useNativeBridge } from '@0xnullai/native';
import { reportStopFailure } from '@0xnullai/ui';

/** One local opt-in for the shell-owned runtime shared by every device-capable module. */
export function ExperimentalDeviceSection() {
  const deviceRuntime = useNativeBridge().deviceRuntime;
  const enabled = useEmbeddedDeviceRuntimeEnabled();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
      <h3 className="text-sm font-semibold">通用设备（实验性）</h3>
      <p className="mt-1 text-xs text-[var(--text-soft)]">
        开启后，Control、Agent、Voice 和 Video 共用。
      </p>
      <label className="mt-3 flex items-center justify-between gap-4">
        <span className="text-sm">启用通用设备</span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!deviceRuntime || busy}
          onChange={(event) => {
            if (!deviceRuntime) return;
            const nextEnabled = event.target.checked;
            setBusy(true);
            setError(null);
            void deviceRuntime
              .setEnabled(nextEnabled)
              .catch((reason: unknown) => {
                if (!nextEnabled) reportStopFailure('实验设备');
                setError(reason instanceof Error ? reason.message : '无法更新实验设备设置');
              })
              .finally(() => setBusy(false));
          }}
          className="accent-[var(--accent)]"
        />
      </label>
      <p className="mt-2 text-xs text-[var(--text-faint)]">
        仅保存在本机；关闭会停止输出并断开设备。
      </p>
      {!deviceRuntime && (
        <p className="mt-2 text-xs text-[var(--text-faint)]">当前入口不提供通用设备运行时。</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </section>
  );
}
