import { useEffect, useState } from 'react';
import { Bluetooth, Settings, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useDeviceSession } from '@/hooks/use-device-session';
import { useSettings } from '@/hooks/use-settings';
import { useRealtimeCall } from '@/hooks/use-realtime-call';
import { CallPanel } from '@/components/CallPanel';
import { DeviceStatusBar } from '@/components/DeviceStatusBar';
import { PermissionModal } from '@/components/PermissionModal';
import {
  SettingsSidebar,
  SettingsWorkspace,
  type SettingsTab,
} from '@/components/settings/SettingsPanel';
import { ResetSettingsDialog } from '@/components/settings/ResetSettingsDialog';
import { applyTheme, subscribeThemeChanges } from '@/services/theme';
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
  const { settings, updateSettings, resetSettings } = useSettings();
  const call = useRealtimeCall(session, settings);
  const callIsBusy = call.state.status === 'connecting' || call.state.status === 'active';

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [settingsMobileNavOpen, setSettingsMobileNavOpen] = useState(true);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  // Theme is applied here (and re-applied when the OS scheme flips in `auto`
  // mode). Nothing else touches `data-theme` at runtime.
  useEffect(() => {
    applyTheme(settings.theme);
    return subscribeThemeChanges(settings.theme, () => applyTheme(settings.theme));
  }, [settings.theme]);

  const openSettings = () => {
    setSettingsMobileNavOpen(true);
    setSettingsOpen(true);
  };
  const closeSettings = () => setSettingsOpen(false);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3">
        <h1 className="text-lg font-semibold">DG-Voice</h1>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={connectDevice} disabled={callIsBusy}>
            <Bluetooth className="h-4 w-4" />
            连接设备
          </Button>
          <Button
            variant={settingsOpen ? 'secondary' : 'ghost'}
            size="icon"
            onClick={settingsOpen ? closeSettings : openSettings}
            disabled={callIsBusy}
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
