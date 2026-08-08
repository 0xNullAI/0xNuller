import { useState } from 'react';
import { Bluetooth, Settings, X } from 'lucide-react';
import { AppSwitcher, Alert, AlertDescription, Button } from '@0xnullai/ui';
import { useDeviceSession } from '@voice/hooks/use-device-session';
import { useSettings } from '@voice/hooks/use-settings';
import { useRealtimeCall } from '@voice/hooks/use-realtime-call';
import { CallPanel } from '@voice/components/CallPanel';
import { DeviceStatusBar } from '@voice/components/DeviceStatusBar';
import { PermissionModal } from '@0xnullai/ui';
import {
  SettingsSidebar,
  SettingsWorkspace,
  type SettingsTab,
} from '@voice/components/settings/SettingsPanel';
import { ResetSettingsDialog } from '@voice/components/settings/ResetSettingsDialog';
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
  const { session, state, error, connecting: connectingDevice, connectDevice, emergencyStop, disconnectCoyote, disconnectOpossum } =
    useDeviceSession(transport);
  const { settings, updateSettings, resetSettings } = useSettings();
  const call = useRealtimeCall(session, settings);
  // Only an *active* call locks the settings entry (reconfiguring mid-call is
  // disruptive). A call that's merely dialing must NOT lock the header — a
  // hung 'connecting' used to latch these buttons disabled forever. Connecting
  // a device is always allowed; it gates on its own in-flight flag instead.
  const callIsActive = call.state.status === 'active';

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [settingsMobileNavOpen, setSettingsMobileNavOpen] = useState(true);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  // 主题由 @0xnullai/ui 的共享 store 唯一持有（跨模块共用一个键、一个 DOM 写入点）。
  // 这里只订阅。原先的注释说「运行时没有别处碰 data-theme」——独立部署时成立，
  // 挂进统一外壳后就不成立了，那正是要收拢它的原因。
  useTheme();

  const openSettings = () => {
    setSettingsMobileNavOpen(true);
    setSettingsOpen(true);
  };
  const closeSettings = () => setSettingsOpen(false);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3">
        <AppSwitcher current="voice" label="DG-Voice" className="text-lg font-semibold" />
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={connectDevice} disabled={connectingDevice}>
            <Bluetooth className="h-4 w-4" />
            {connectingDevice ? '连接中…' : '连接设备'}
          </Button>
          <Button
            variant={settingsOpen ? 'secondary' : 'ghost'}
            size="icon"
            onClick={settingsOpen ? closeSettings : openSettings}
            disabled={callIsActive}
            aria-label={settingsOpen ? '关闭设置' : '设置'}
          >
            {settingsOpen ? <X className="h-4 w-4" /> : <Settings className="h-4 w-4" />}
          </Button>
        </div>
      </header>

      {settingsOpen ? (
        <section className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden lg:grid-cols-[272px_minmax(0,1fr)]">
          <aside className="hidden min-h-0 overflow-hidden border-r border-[var(--surface-border)] lg:block">
            <SettingsSidebar
              tab={settingsTab}
              onTabChange={setSettingsTab}
              onMobileNavOpenChange={setSettingsMobileNavOpen}
              onClose={closeSettings}
              onRequestReset={() => setResetDialogOpen(true)}
            />
          </aside>
          <SettingsWorkspace
            tab={settingsTab}
            onTabChange={setSettingsTab}
            mobileNavOpen={settingsMobileNavOpen}
            onMobileNavOpenChange={setSettingsMobileNavOpen}
            onClose={closeSettings}
            onRequestReset={() => setResetDialogOpen(true)}
            settings={settings}
            updateSettings={updateSettings}
          />
        </section>
      ) : (
        <>
          <DeviceStatusBar
            state={state}
            coyoteSafety={settings.coyoteSafety}
            opossumSafety={settings.opossumSafety}
            onDisconnectCoyote={() => void disconnectCoyote()}
            onDisconnectOpossum={() => void disconnectOpossum()}
          />

          <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 overflow-y-auto px-4 py-6">
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
        </>
      )}

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

      <ResetSettingsDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen} onConfirm={resetSettings} />
    </div>
  );
}
