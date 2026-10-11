import { useEffect, useState } from 'react';
import { Bluetooth, LoaderCircle, Square, X } from 'lucide-react';
import { allConnectedDevices, safetySessionById, subscribeSafetySessions } from '@dg-kit/safety';
// The device names are @dg-kit/core's to own. This file used to keep its own
// copy, which called civet-edging 灵狐 while every other module said 灵猫 —
// the same device read differently in the top bar and in a Voice transcript.
import { DEVICE_KIND_DISPLAY_NAME, isDevicePickerCancelled } from '@dg-kit/core';
import type { DeviceSummary } from '@dg-kit/safety';
import { BatteryIcon, stopAllDevices } from '@0xnullai/ui';
import { DGLAB_SAFETY_SESSION_ID } from '@0xnullai/device-runtime';

/**
 * The one device bar for the unified shell. It stays at the top of every module
 * that can connect devices, even before a device is attached; once anything is
 * connected it also survives navigation to non-device modules so stop never
 * disappears.
 *
 * Disconnecting is a 设备-page action only: the devices are shared by every
 * module, so a ✕ in an AI chat or a game would drop the link for all of them.
 * Elsewhere the bar shows the device and the stop button, not the ✕.
 *
 * Visibility therefore has two signals: the active module exposes a connect
 * capability, or at least one device is connected. Output state only changes the
 * stop button's emphasis; it never decides whether the safety anchor exists.
 *
 * Polling rather than pure event-driven updates, for the same reason:
 * `subscribeSafetySessions` only fires when a module mounts/unmounts, and changes
 * to battery, intensity or connection state do not go through it. The cost of
 * missing an update is that the user sees stale device state — and that is exactly
 * what they use to judge whether things are safe right now.
 */

const POLL_MS = 1000;

/** The 设备 module's lease id. Only there does the bar offer per-device disconnect. */
const DEVICE_PAGE_MODULE_ID = 'control';

function useConnectedDevices() {
  const [groups, setGroups] = useState(() => allConnectedDevices());

  useEffect(() => {
    const refresh = () => setGroups(allConnectedDevices());
    const stop = subscribeSafetySessions(refresh);
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      stop();
      window.clearInterval(timer);
    };
  }, []);

  return groups;
}

/** DeviceSummary.kind is a free-form string — a module may report a kind kit
 *  does not know about — so fall back to the raw value instead of blanking. */
function kindLabel(device: DeviceSummary): string {
  return (
    (DEVICE_KIND_DISPLAY_NAME as Record<string, string>)[device.kind] ?? device.name ?? device.kind
  );
}

/**
 * One device's row.
 *
 * `owner` is the session that reports it. The shared DG-Lab registry session
 * gets no tag: its devices belong to the app, not to a module. Other sessions
 * keep theirs when several sessions are represented or when a background
 * module owns the only attached device.
 *
 * An outputting device is marked in words as well as by the dot. The dot alone
 * carries the single most important piece of state on this bar — whether
 * something is running on the user's body right now — through colour only,
 * which is the one channel a user may not be able to read.
 */
function DeviceChip({
  device,
  owner,
  displayLabel,
  disconnecting,
  onDisconnect,
}: {
  device: DeviceSummary;
  owner: string | null;
  displayLabel: string;
  disconnecting: boolean;
  onDisconnect?: () => void;
}) {
  const active = device.active;
  const activeKnown = typeof active === 'boolean';
  return (
    <div
      className={
        'flex h-9 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 ' +
        (active === true
          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
          : 'border-transparent bg-[var(--bg-soft)]')
      }
    >
      <span
        className={
          'h-2 w-2 shrink-0 rounded-full ' +
          (active === true
            ? 'bg-[var(--accent)] motion-safe:animate-pulse'
            : activeKnown
              ? 'bg-[var(--success)]'
              : 'bg-[var(--text-faint)]')
        }
        aria-hidden
      />
      <span className="shrink-0 text-xs font-medium">{displayLabel}</span>
      {owner && (
        <span className="shrink-0 rounded-full bg-[var(--bg-elevated)] px-1.5 text-[10px] text-[var(--text-faint)]">
          {owner}
        </span>
      )}
      {device.channels?.map((ch) => (
        <span
          key={ch.label}
          className={
            'shrink-0 font-mono text-xs tabular-nums ' +
            (ch.value > 0 ? 'font-semibold text-[var(--accent)]' : 'text-[var(--text-soft)]')
          }
          title={`${ch.label} 通道：${ch.value} / 上限 ${ch.max}`}
        >
          {ch.label}
          {ch.value}
        </span>
      ))}
      {device.readings?.map((reading, index) => (
        <span
          key={`${reading.label ?? 'reading'}-${index}`}
          className="shrink-0 font-mono text-xs font-semibold tabular-nums text-[var(--accent)]"
          title={reading.label || '传感器读数'}
        >
          {reading.label ? `${reading.label} ` : ''}
          {reading.value}
          {reading.unit ?? ''}
        </span>
      ))}
      {/* Words as well as the dot, so the output state never depends on colour alone.
          Standby is the quiet default: visible to screen readers, not on screen. */}
      <span
        className={
          active === true
            ? 'shrink-0 text-[11px] font-medium text-[var(--accent-text)]'
            : activeKnown
              ? 'sr-only'
              : 'shrink-0 text-[11px] text-[var(--text-faint)]'
        }
      >
        {active === true ? '输出中' : activeKnown ? '待机' : '状态未知'}
      </span>
      {typeof device.battery === 'number' && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-faint)]">
          <BatteryIcon level={device.battery} />
          {device.battery}%
        </span>
      )}
      {onDisconnect && (
        <button
          type="button"
          disabled={disconnecting}
          onClick={onDisconnect}
          className="-mr-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-strong)] hover:text-[var(--danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
          aria-label={`断开${displayLabel}`}
          title={`断开${displayLabel}`}
        >
          {disconnecting ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
        </button>
      )}
    </div>
  );
}

export function DeviceBar({
  activeSessionId = null,
  showConnect = true,
  elementId = 'shl-device-bar',
}: {
  activeSessionId?: string | null;
  showConnect?: boolean;
  elementId?: string;
}) {
  const groups = useConnectedDevices();
  const [stopping, setStopping] = useState(false);
  const [connectState, setConnectState] = useState<{
    sessionId: string | null;
    connecting: boolean;
    error: string | null;
  }>({ sessionId: null, connecting: false, error: null });
  const [disconnectState, setDisconnectState] = useState<{
    key: string | null;
    error: string | null;
  }>({ key: null, error: null });
  const activeSession = safetySessionById(activeSessionId);
  const canConnect = typeof activeSession?.connect === 'function';
  const connecting = connectState.sessionId === activeSessionId && connectState.connecting;
  const connectError = connectState.sessionId === activeSessionId ? connectState.error : null;

  if (groups.length === 0 && (!canConnect || !showConnect)) return null;

  const rows = groups.flatMap((group) => group.devices.map((device) => ({ group, device })));
  const total = rows.length;
  const hasActiveOutput = groups.some((group) => group.devices.some((device) => device.active));
  const kindTotals = new Map<string, number>();
  for (const { device } of rows) {
    kindTotals.set(device.kind, (kindTotals.get(device.kind) ?? 0) + 1);
  }
  const kindSeen = new Map<string, number>();

  return (
    <div
      id={elementId}
      className="flex shrink-0 items-center gap-1.5 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-1"
    >
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Stop goes at the far left (first in reading order). It is the primary reason
          this bar exists, not an accessory feature. */}
        {total > 0 && (
          <button
            type="button"
            onClick={async () => {
              setStopping(true);
              try {
                await stopAllDevices();
              } finally {
                setStopping(false);
              }
            }}
            className={`ui-press sticky left-0 z-[1] flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 ${
              hasActiveOutput
                ? 'border-transparent bg-[var(--danger-button)] text-white hover:bg-[var(--danger-button-hover)] focus-visible:ring-[var(--danger)]'
                : // Idle: a plain button with a red stop square, clearly clickable but quiet.
                  'border-[var(--surface-border)] bg-[var(--bg-strong)] text-[var(--text)] hover:border-[var(--danger)] hover:bg-[var(--danger-soft)] focus-visible:ring-[var(--danger)]'
            }`}
            title={
              hasActiveOutput
                ? `立刻停止全部输出（${total} 台设备）`
                : `将全部已连接设备归零（${total} 台设备）`
            }
          >
            <Square
              className={`h-3.5 w-3.5 fill-current ${hasActiveOutput ? '' : 'text-[var(--danger)]'}`}
            />
            {stopping ? '归零中…' : hasActiveOutput ? '停止' : '归零'}
          </button>
        )}

        <div className="flex flex-nowrap items-center gap-1.5">
          {rows.map(({ group, device }) => {
            const ordinal = (kindSeen.get(device.kind) ?? 0) + 1;
            kindSeen.set(device.kind, ordinal);
            const baseLabel = kindLabel(device);
            const displayLabel =
              (kindTotals.get(device.kind) ?? 0) > 1 ? `${baseLabel} ${ordinal}` : baseLabel;
            const session = safetySessionById(group.sessionId);
            const disconnectKey = `${group.sessionId}:${device.id}`;
            // Shared DG-Lab devices are disconnected from their card on the 设备 page, so
            // the bar does not repeat that control; other device groups keep the ✕ there.
            const canDisconnect =
              activeSessionId === DEVICE_PAGE_MODULE_ID &&
              group.sessionId !== DGLAB_SAFETY_SESSION_ID &&
              typeof session?.disconnect === 'function';
            return (
              // Keyed by module + device id: two modules may legitimately report
              // the same device id, and one module may now report several
              // devices. Either half alone collides, and a collided key means a
              // row React never renders — a device attached to the user with no
              // sign of it here.
              <DeviceChip
                key={`${group.sessionId}:${device.id}`}
                device={device}
                owner={
                  group.sessionId === DGLAB_SAFETY_SESSION_ID
                    ? null
                    : groups.length > 1 || group.sessionId !== activeSessionId
                      ? group.label
                      : null
                }
                displayLabel={displayLabel}
                disconnecting={disconnectState.key === disconnectKey}
                onDisconnect={
                  canDisconnect
                    ? () => {
                        if (!session?.disconnect || disconnectState.key) return;
                        setDisconnectState({ key: disconnectKey, error: null });
                        void Promise.resolve()
                          .then(() => session.disconnect?.(device.id))
                          .then(() => setDisconnectState({ key: null, error: null }))
                          .catch((error: unknown) =>
                            setDisconnectState({
                              key: null,
                              error:
                                error instanceof Error ? error.message : `无法断开${displayLabel}`,
                            }),
                          );
                      }
                    : undefined
                }
              />
            );
          })}
        </div>
        {disconnectState.error && (
          <span role="alert" className="shrink-0 whitespace-nowrap text-xs text-[var(--danger)]">
            {disconnectState.error}
          </span>
        )}
      </div>

      {connectError && (
        <span
          role="alert"
          className="max-w-48 shrink truncate text-xs text-[var(--danger)]"
          title={connectError}
        >
          {connectError}
        </span>
      )}

      {canConnect && showConnect && (
        <button
          type="button"
          disabled={connecting}
          onClick={async () => {
            if (!activeSession?.connect || connecting) return;
            setConnectState({ sessionId: activeSessionId, connecting: true, error: null });
            try {
              await activeSession.connect();
              setConnectState({ sessionId: activeSessionId, connecting: false, error: null });
            } catch (error) {
              setConnectState({
                sessionId: activeSessionId,
                connecting: false,
                error: isDevicePickerCancelled(error)
                  ? null
                  : error instanceof Error
                    ? error.message
                    : '连接设备失败',
              });
            }
          }}
          className="ui-press ml-auto flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--accent)] px-3 text-[13px] font-semibold text-[var(--button-text)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
          title={total > 0 ? '连接其他设备' : '连接设备'}
        >
          {connecting ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Bluetooth className="h-3.5 w-3.5" />
          )}
          {connecting ? '连接中…' : '连接设备'}
        </button>
      )}
    </div>
  );
}
