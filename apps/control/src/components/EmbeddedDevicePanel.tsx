import { useCallback, useEffect, useRef, useState } from 'react';
import { Bluetooth, LoaderCircle, Unplug } from 'lucide-react';
import { useNativeBridge } from '@0xnullai/native';
import { loadDeviceSafety, subscribeDeviceSafety } from '@0xnullai/settings';
import type {
  BoundDeviceTools,
  DeviceSnapshot,
  FeatureId,
  RuntimeDevice,
} from '@0xnullai/device-runtime';

const OUTPUT_LEASE_MS = 1_000;

function interactionId(action: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `control-human/${action}/${random}`.slice(0, 128);
}

/** Separate generic-device UI. Existing Coyote/Opossum controls remain untouched below it. */
export function EmbeddedDevicePanel() {
  const provider = useNativeBridge().deviceRuntime;
  const [enabled, setEnabled] = useState(() => provider?.isEnabled() ?? false);
  const [snapshot, setSnapshot] = useState<DeviceSnapshot | null>(
    () => provider?.current()?.snapshot() ?? null,
  );
  const [intensities, setIntensities] = useState<Record<string, number>>({});
  const [intensityCap, setIntensityCap] = useState(
    () => Math.min(loadDeviceSafety().maxIntensityA, loadDeviceSafety().maxIntensityB) / 200,
  );
  const [scanning, setScanning] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toolsRef = useRef<BoundDeviceTools | null>(null);
  const openingRef = useRef<Promise<BoundDeviceTools> | null>(null);
  const unsubscribeSnapshotRef = useRef<(() => void) | null>(null);

  useEffect(
    () =>
      subscribeDeviceSafety((settings) =>
        setIntensityCap(Math.min(settings.maxIntensityA, settings.maxIntensityB) / 200),
      ),
    [],
  );

  useEffect(() => {
    if (!provider) return;
    return provider.subscribeEnabled((next) => {
      setEnabled(next);
      if (!next) {
        toolsRef.current = null;
        openingRef.current = null;
        unsubscribeSnapshotRef.current?.();
        unsubscribeSnapshotRef.current = null;
        setSnapshot(null);
        setIntensities({});
      }
    });
  }, [provider]);

  useEffect(
    () => () => {
      unsubscribeSnapshotRef.current?.();
    },
    [],
  );

  const ensureTools = useCallback(async (): Promise<BoundDeviceTools> => {
    if (!provider) throw new Error('当前入口不提供嵌入式设备运行时');
    if (toolsRef.current) return toolsRef.current;
    if (openingRef.current) return openingRef.current;
    const opening = provider.forModule('control').then((tools) => {
      const runtime = provider.current();
      if (!runtime) throw new Error('嵌入式设备运行时未启动');
      toolsRef.current = tools;
      setSnapshot(runtime.snapshot());
      unsubscribeSnapshotRef.current?.();
      unsubscribeSnapshotRef.current = runtime.manager.subscribe(setSnapshot);
      return tools;
    });
    openingRef.current = opening;
    try {
      return await opening;
    } finally {
      if (openingRef.current === opening) openingRef.current = null;
    }
  }, [provider]);

  const stopFeature = useCallback(
    async (deviceId: RuntimeDevice['deviceId'], featureId: FeatureId) => {
      // Release can happen while the one-shot backend is still opening. Wait
      // for that same opening promise so a late vibrate cannot land unopposed.
      const tools = toolsRef.current ?? (await openingRef.current);
      if (!tools) return;
      const ack = await tools.actions.stop({
        interactionId: interactionId('release-stop'),
        deviceId,
        featureId,
      });
      if (ack.status !== 'stopped') throw new Error(`停止失败：${ack.code}`);
    },
    [],
  );

  if (!provider) return null;

  return (
    <section
      aria-label="通用设备"
      className="rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">通用设备（实验性）</h2>
          <p className="mt-1 text-xs text-[var(--text-soft)]">
            每个设备和功能按运行时原样列出；振动强度统一为 0–1。
          </p>
        </div>
        <button
          type="button"
          disabled={!enabled || scanning}
          onClick={() => {
            if (scanning) return;
            setScanning(true);
            setError(null);
            void ensureTools()
              .then((tools) =>
                tools.actions.scan({ interactionId: interactionId('scan') }).then((ack) => {
                  if (ack.status !== 'applied') throw new Error(`扫描失败：${ack.code}`);
                }),
              )
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : '无法扫描通用设备'),
              )
              .finally(() => setScanning(false));
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-[var(--radius-ctl)] bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--button-text)] disabled:opacity-50"
        >
          {scanning ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Bluetooth className="h-3.5 w-3.5" />
          )}
          {scanning ? '扫描中…' : '扫描通用设备'}
        </button>
      </div>

      {!enabled && (
        <p className="mt-3 text-xs text-[var(--text-faint)]">
          默认关闭。请先在“设备安全 → Experimental Device”中启用。
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}

      {enabled && snapshot && snapshot.devices.length === 0 && (
        <p className="mt-3 text-xs text-[var(--text-faint)]">尚未发现通用设备。</p>
      )}

      {snapshot?.devices.map((device) => (
        <article
          key={device.deviceId}
          className="mt-3 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold">{device.name}</h3>
              <code className="block break-all text-[10px] text-[var(--text-faint)]">
                {device.deviceId}
              </code>
            </div>
            <button
              type="button"
              disabled={disconnecting !== null}
              onClick={() => {
                setDisconnecting(device.deviceId);
                setError(null);
                void ensureTools()
                  .then((tools) =>
                    tools.actions
                      .disconnect({
                        interactionId: interactionId('disconnect'),
                        deviceId: device.deviceId,
                      })
                      .then((ack) => {
                        if (ack.status !== 'applied') {
                          throw new Error(`断开失败：${ack.code}`);
                        }
                      }),
                  )
                  .catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : '无法断开通用设备'),
                  )
                  .finally(() => setDisconnecting(null));
              }}
              className="flex shrink-0 items-center gap-1 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] px-2 py-1 text-xs text-[var(--text-soft)] disabled:opacity-50"
            >
              <Unplug className="h-3.5 w-3.5" />
              {disconnecting === device.deviceId ? '断开中…' : '断开'}
            </button>
          </div>

          <ul className="mt-3 flex flex-col gap-2">
            {device.capabilities.map((capability, index) => {
              const featureLabel = `功能 ${index + 1}`;
              if (capability.kind === 'battery') {
                return (
                  <li key={capability.featureId} className="text-xs">
                    <span className="font-medium">{featureLabel} · Battery</span>{' '}
                    <span>
                      {capability.value === null
                        ? '未知'
                        : `${Math.round(capability.value * 100)}%`}
                    </span>
                    <code className="ml-2 break-all text-[10px] text-[var(--text-faint)]">
                      {capability.featureId}
                    </code>
                  </li>
                );
              }
              if (capability.kind === 'rssi') {
                return (
                  <li key={capability.featureId} className="text-xs">
                    <span className="font-medium">{featureLabel} · RSSI</span>{' '}
                    <span>{capability.value === null ? '未知' : `${capability.value} dBm`}</span>
                    <code className="ml-2 break-all text-[10px] text-[var(--text-faint)]">
                      {capability.featureId}
                    </code>
                  </li>
                );
              }

              const value = intensities[capability.featureId] ?? 0;
              const stop = () => {
                setIntensities((current) => ({ ...current, [capability.featureId]: 0 }));
                void stopFeature(device.deviceId, capability.featureId).catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : '无法停止振动功能'),
                );
              };
              return (
                <li
                  key={capability.featureId}
                  className="rounded-[var(--radius-sm)] bg-[var(--bg-soft)] p-2"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">{featureLabel} · Vibrate</span>
                    <span className="font-mono tabular-nums">{value.toFixed(2)}</span>
                  </div>
                  <code className="block break-all text-[10px] text-[var(--text-faint)]">
                    {capability.featureId}
                  </code>
                  <input
                    aria-label={`${device.name} ${featureLabel} 归一化振动强度`}
                    type="range"
                    min={0}
                    max={intensityCap}
                    step={1 / capability.stepCount}
                    value={value}
                    onPointerDown={(event) =>
                      event.currentTarget.setPointerCapture?.(event.pointerId)
                    }
                    onChange={(event) => {
                      const intensity = Math.min(
                        intensityCap,
                        Math.max(0, Number(event.target.value)),
                      );
                      setIntensities((current) => ({
                        ...current,
                        [capability.featureId]: intensity,
                      }));
                      setError(null);
                      void ensureTools()
                        .then((tools) =>
                          tools.actions
                            .vibrate({
                              interactionId: interactionId('vibrate'),
                              deviceId: device.deviceId,
                              featureId: capability.featureId,
                              intensity,
                              outputLeaseMs: OUTPUT_LEASE_MS,
                            })
                            .then((ack) => {
                              if (ack.status !== 'applied') {
                                throw new Error(`振动指令被拒绝：${ack.code}`);
                              }
                            }),
                        )
                        .catch((reason: unknown) =>
                          setError(reason instanceof Error ? reason.message : '无法设置振动强度'),
                        );
                    }}
                    onPointerUp={stop}
                    onPointerCancel={stop}
                    onLostPointerCapture={stop}
                    onKeyUp={stop}
                    onBlur={stop}
                    className="mt-2 w-full accent-[var(--accent)]"
                  />
                </li>
              );
            })}
          </ul>
        </article>
      ))}
    </section>
  );
}
