import { useState } from 'react';
import { Bluetooth, Settings, X } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  Button,
  ModuleActions,
  useInShell,
  useSafetySession,
} from '@0xnullai/ui';
import { useNativeBridge } from '@0xnullai/native';
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
  // 同 Chat：props 优先，否则从 NativeBridge 取。
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

  // 注册到全局安全总线——外壳的全局停止按钮唯一的数据来源。
  useSafetySession({
    id: 'voice',
    label: 'Voice',
    isActive: () => Boolean(state.coyote?.connected || state.opossum?.connected),
    stop: emergencyStop,
    onRevoke: async () => {
      // 切走 Voice 时挂断通话再停输出。只停输出的话通话还连着，模型继续说话、
      // 继续下工具调用——用户以为自己已经离开了。
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
  const inShell = useInShell();
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
      {/* 外壳里不画自己的 header——全局只有一条横栏，按钮通过 ModuleActions 投上去。
          独立部署时 ModuleActions 原地渲染，这条 header 照旧。 */}
      {/* 模块名由外壳侧边栏顶部表达；这两个按钮投到外壳的按钮插槽。 */}
      <ModuleActions>
        <Button variant="secondary" size="sm" onClick={connectDevice} disabled={connectingDevice}>
          <Bluetooth className="h-4 w-4" />
          <span className="hidden sm:inline">{connectingDevice ? '连接中…' : '连接设备'}</span>
        </Button>
        {/* 外壳里没有这个按钮：设置只有一个入口，在侧边栏底部的账户菜单里。
            这套面板的四页在那边都有对应（主题→外观、供应商与音色→AI、场景→场景、
            强度上限→设备安全），留着就是同一件事两处能改，改哪处生效取决于当时
            开着哪个模块——那正是合并要消掉的东西。 */}
        {!inShell && (
          <Button
            variant={settingsOpen ? 'secondary' : 'ghost'}
            size="icon"
            onClick={settingsOpen ? closeSettings : openSettings}
            disabled={callIsActive}
            aria-label={settingsOpen ? '关闭设置' : '设置'}
          >
            {settingsOpen ? <X className="h-4 w-4" /> : <Settings className="h-4 w-4" />}
          </Button>
        )}
      </ModuleActions>

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

      <ResetSettingsDialog
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        onConfirm={resetSettings}
      />
    </div>
  );
}
