import { Bluetooth } from 'lucide-react';
import { Alert, AlertDescription, Button, ModuleActions, useSafetySession } from '@0xnullai/ui';
import { useNativeBridge } from '@0xnullai/native';
import { useDeviceSession } from '@voice/hooks/use-device-session';
import { useSettings } from '@voice/hooks/use-settings';
import { useRealtimeCall } from '@voice/hooks/use-realtime-call';
import { CallPanel } from '@voice/components/CallPanel';
import { DeviceStatusBar } from '@voice/components/DeviceStatusBar';
import { PermissionModal } from '@0xnullai/ui';
import { useTheme } from '@0xnullai/ui';
import type { DeviceSessionTransport } from '@voice/lib/device-session';

interface AppProps {
  /**
   * Only supplied by the Android shell (`apps/tauri-android`), which injects
   * the `@dg-kit/transport-tauri-blec` clients. The web build omits it and
   * falls through to the Web Bluetooth default.
   */
  transport?: DeviceSessionTransport;
}

export function App({ transport }: AppProps = {}) {
  // Same as Chat: props win, otherwise take it from the NativeBridge.
  const native = useNativeBridge();
  const {
    session,
    state,
    error,
    connecting: connectingDevice,
    connectDevice,
    emergencyStop,
    disconnectCoyote,
    disconnectOpossum,
  } = useDeviceSession(transport ?? (native.voice?.transport as typeof transport));

  // Register on the global safety bus — the only data source the shell's
  // global stop button has.
  useSafetySession({
    id: 'voice',
    label: 'Voice',
    isActive: () => Boolean(state.coyote?.connected || state.opossum?.connected),
    stop: emergencyStop,
    onRevoke: async () => {
      // Hang the call up before stopping output when switching away from
      // Voice. Stopping output alone leaves the call connected: the model keeps
      // talking and keeps issuing tool calls — while the user believes they
      // already left.
      await call.hangUp('切换到其他模块').catch(() => undefined);
      await emergencyStop();
    },
    devices: () => [
      ...(state.coyote?.connected
        ? [
            {
              id: 'coyote',
              kind: 'coyote',
              name: state.coyote.deviceName ?? '郊狼',
              connected: true,
              battery: state.coyote.battery,
              active: state.coyote.strengthA > 0 || state.coyote.strengthB > 0,
              channels: [
                { label: 'A', value: state.coyote.strengthA, max: state.coyote.limitA },
                { label: 'B', value: state.coyote.strengthB, max: state.coyote.limitB },
              ],
            },
          ]
        : []),
      ...(state.opossum?.connected
        ? [{ id: 'opossum', kind: 'opossum', name: '负鼠', connected: true }]
        : []),
    ],
  });
  const { settings } = useSettings();
  const call = useRealtimeCall(session, settings);
  // Only an *active* call locks the settings entry (reconfiguring mid-call is
  // disruptive). A call that's merely dialing must NOT lock the header — a
  // hung 'connecting' used to latch these buttons disabled forever. Connecting
  // a device is always allowed; it gates on its own in-flight flag instead.

  // The theme is held solely by @0xnullai/ui's shared store (one key and one
  // DOM write point shared across modules). This only subscribes. The old
  // comment here said "nothing else touches data-theme at runtime" — true for a
  // standalone deployment, no longer true once mounted inside the unified
  // shell, which is exactly why it had to be consolidated.
  useTheme();

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--text)]">
      {/* Inside the shell we don't draw a header of our own — there is one
          global bar, and buttons are projected onto it through ModuleActions.
          In a standalone deployment ModuleActions renders in place and this
          header stays as it was. */}
      {/* The module name is expressed by the top of the shell's sidebar; these
          two buttons go into the shell's button slot. */}
      <ModuleActions>
        <Button variant="secondary" size="sm" onClick={connectDevice} disabled={connectingDevice}>
          <Bluetooth className="h-4 w-4" />
          <span className="hidden sm:inline">{connectingDevice ? '连接中…' : '连接设备'}</span>
        </Button>
      </ModuleActions>

      <DeviceStatusBar
        state={state}
        coyoteSafety={settings.coyoteSafety}
        opossumSafety={settings.opossumSafety}
        onDisconnectCoyote={() => void disconnectCoyote()}
        onDisconnectOpossum={() => void disconnectOpossum()}
      />

      {/* justify-center, because before a call starts this whole module is
              one card. Top-aligned it sat against the device bar with most of
              a 900px window empty underneath, which reads as a page that
              stopped loading. min-h-0 keeps it scrollable once a running call
              makes the content taller than the viewport. */}
      <main className="mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col justify-center gap-4 overflow-y-auto px-4 py-6">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <CallPanel
          call={call.state}
          providerId={settings.activeProviderId}
          onStart={() => void call.startCall()}
          onHangUp={() => void call.hangUp()}
          onEmergencyStop={() => void emergencyStop()}
        />
      </main>

      {call.pendingPermission && (
        <PermissionModal
          summary={call.pendingPermission.input.summary}
          args={call.pendingPermission.input.args}
          onDeny={() => call.resolvePermission({ type: 'deny' })}
          onAllowOnce={() => call.resolvePermission({ type: 'approve-once' })}
          onAllowTimed={() =>
            call.resolvePermission({ type: 'approve-scoped', expiresAt: Date.now() + 5 * 60_000 })
          }
          onAllowSession={() => call.resolvePermission({ type: 'approve-scoped' })}
        />
      )}
    </div>
  );
}
