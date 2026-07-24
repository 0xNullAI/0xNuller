import { Bluetooth, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useDeviceSession } from '@/hooks/use-device-session';
import { useSettings } from '@/hooks/use-settings';
import { useRealtimeCall } from '@/hooks/use-realtime-call';
import { CallPanel } from '@/components/CallPanel';
import { SettingsSheet } from '@/components/SettingsSheet';
import { DeviceStatusBar } from '@/components/DeviceStatusBar';
import { PermissionModal } from '@/components/PermissionModal';
import type { DeviceSessionTransport } from '@/lib/device-session';

interface AppProps {
  /**
   * Only supplied by the Android shell (`apps/tauri-android`), which injects
   * the `@dg-kit/transport-tauri-blec` clients. The web build omits it and
   * falls through to the Web Bluetooth default.
   */
  transport?: DeviceSessionTransport;
}

export function App({ transport }: AppProps = {}) {
  const { session, state, error, connectDevice, emergencyStop, disconnectCoyote, disconnectOpossum } =
    useDeviceSession(transport);
  const { settings, updateSettings } = useSettings();
  const call = useRealtimeCall(session, settings);
  const callIsBusy = call.state.status === 'connecting' || call.state.status === 'active';

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="flex items-center justify-between border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3">
        <h1 className="text-lg font-semibold">DG-Voice</h1>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={connectDevice} disabled={callIsBusy}>
            <Bluetooth className="h-4 w-4" />
            连接设备
          </Button>
          <SettingsSheet settings={settings} updateSettings={updateSettings} disabled={callIsBusy} />
        </div>
      </header>

      <DeviceStatusBar
        state={state}
        coyoteSafety={settings.coyoteSafety}
        opossumSafety={settings.opossumSafety}
        onDisconnectCoyote={() => void disconnectCoyote()}
        onDisconnectOpossum={() => void disconnectOpossum()}
      />

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6">
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
        />

        <Button variant="destructive" className="w-full" onClick={() => void emergencyStop()}>
          <ShieldAlert className="h-4 w-4" />
          紧急停止（不挂断通话，仅归零设备）
        </Button>
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
