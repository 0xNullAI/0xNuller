import {
  Button,
  useShellNav,
  Alert,
  AlertDescription,
  DeviceSafetyButton,
  ModuleActions,
  OpossumControl,
  useInShell,
  useSafetySession,
} from '@0xnullai/ui';
import { useEffect, useState } from 'react';
import { useDgLabRegistry, useNativeBridge } from '@0xnullai/native';
import { useDeviceSession } from '@voice/hooks/use-device-session';
import { useSettings } from '@voice/hooks/use-settings';
import { useRealtimeCall } from '@voice/hooks/use-realtime-call';
import { CallPanel } from '@voice/components/CallPanel';
import { DeviceStatusBar } from '@voice/components/DeviceStatusBar';
import { PermissionModal } from '@0xnullai/ui';
import { useTheme } from '@0xnullai/ui';
import { createRegistryTransport } from '@voice/lib/device-session';

/** Must match the shell's lease id for this module (`apps/web/src/routes.ts`). */
const VOICE_MODULE_ID = 'voice';

export function App() {
  const inShell = useInShell();
  const shellNav = useShellNav();
  const native = useNativeBridge();
  // The app's one DG-Lab registry (a lazy Web Bluetooth one in a standalone build). Read once:
  // the session is built once and keeps its transport for its lifetime.
  const registry = useDgLabRegistry();
  const [deviceTransport] = useState(() =>
    createRegistryTransport(registry.forModule(VOICE_MODULE_ID)),
  );
  const { session, state, error, connectDevice, emergencyStop, onRevoked } =
    useDeviceSession(deviceTransport);
  const { settings, updateSettings } = useSettings();

  // Register on the global safety bus — the only data source the shell's
  // global stop button has.
  useSafetySession({
    id: VOICE_MODULE_ID,
    label: 'Voice',
    isActive: () => Boolean(state.coyotes.length > 0 || state.opossum?.connected),
    stop: emergencyStop,
    connect: connectDevice,
    // Ending the call stops the model from issuing more tool calls while the user believes
    // they already left. The registry has already stopped every output on the lease switch,
    // so the hang-up issues no device stop: stops bypass the lease fence and would zero
    // output the new holder starts right after the switch. The devices themselves are
    // listed by the registry's own `dglab-devices` session.
    onRevoke: async () => {
      await call.hangUp('切换到其他模块', false, { stopOutput: false }).catch(() => undefined);
    },
  });
  const call = useRealtimeCall(session, settings, native.deviceRuntime);
  const { hangUp } = call;
  // The registry tells Voice directly as well; same state-only hang-up as the bus revoke above.
  useEffect(
    () =>
      onRevoked(() => {
        void hangUp('切换到其他模块', false, { stopOutput: false }).catch(() => undefined);
      }),
    [onRevoked, hangUp],
  );
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
          device controls go into the shell's shared action slot. */}
      <ModuleActions>
        {!inShell && (
          <DeviceSafetyButton
            connected={state.coyote.connected}
            deviceName={state.coyote.deviceName ?? null}
            battery={state.coyote.battery ?? null}
            limitA={settings.coyoteSafety.maxStrengthA}
            limitB={settings.coyoteSafety.maxStrengthB}
            onSetLimit={(channel, value) =>
              updateSettings((current) => ({
                ...current,
                coyoteSafety: {
                  ...current.coyoteSafety,
                  [channel === 'A' ? 'maxStrengthA' : 'maxStrengthB']: value,
                },
              }))
            }
            sensor={null}
            opossum={
              state.opossum.connected
                ? {
                    connected: true,
                    deviceName: state.opossum.deviceName ?? '负鼠',
                    battery: state.opossum.battery ?? null,
                    intensityA: state.opossum.intensityA,
                    intensityB: state.opossum.intensityB,
                    limitA: settings.opossumSafety.maxIntensityA,
                    limitB: settings.opossumSafety.maxIntensityB,
                    waveIdA: null,
                    waveIdB: null,
                    lastButtons: null,
                    lastButtonsAt: null,
                  }
                : null
            }
            onConnectDevice={connectDevice}
            supportedDeviceKinds={['coyote', 'opossum']}
          />
        )}
      </ModuleActions>

      {!inShell && (
        <DeviceStatusBar
          state={state}
          coyoteSafety={settings.coyoteSafety}
          opossumSafety={settings.opossumSafety}
          onStop={() => void emergencyStop().catch(() => undefined)}
        />
      )}

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

        <OpossumControl
          connected={state.opossum.connected}
          battery={state.opossum.battery}
          intensityA={state.opossum.intensityA}
          intensityB={state.opossum.intensityB}
          limitA={settings.opossumSafety.maxIntensityA}
          limitB={settings.opossumSafety.maxIntensityB}
          onAdjust={(channel, delta) =>
            void session.opossum.execute({ type: 'vibrateAdjust', channel, delta })
          }
          onBurst={(channel, strength, durationMs) =>
            void session.opossum.execute({
              type: 'vibrateBurst',
              channel,
              intensity: Math.min(
                strength,
                channel === 'A'
                  ? settings.opossumSafety.maxIntensityA
                  : settings.opossumSafety.maxIntensityB,
              ),
              durationMs,
            })
          }
          onStop={() => void session.opossum.emergencyStop()}
          onPatternChange={(channel, pattern) =>
            void session.opossum.execute({ type: 'vibrateSetPattern', channel, pattern })
          }
        />

        {shellNav && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                void call.hangUp().then(async () => {
                  if (await call.retryHistory()) shellNav.navigate('agent');
                })
              }
            >
              继续文字对话
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                void call.hangUp().then(async () => {
                  if (await call.retryHistory()) shellNav.navigate('video');
                })
              }
            >
              摄像头观察
            </Button>
          </div>
        )}
        <CallPanel
          call={call.state}
          onRetryHistory={() => void call.retryHistory()}
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
