import { useCallback, useEffect, useRef, useState } from 'react';
import { MarketImportDialog, useSafetySession } from '@0xnullai/ui';
import { currentDeviceLease, subscribeSafetySessions } from '@dg-kit/safety';
import { useNativeBridge } from '@0xnullai/native';
import { loadDeviceSafety, subscribeDeviceSafety } from '@0xnullai/settings';
import { useDevice } from '../../chat/src/hooks/use-device';
import { useWaveforms } from '../../chat/src/hooks/use-waveforms';
import { useChannelRotation } from '../../chat/src/hooks/use-channel-rotation';
import type {
  ChannelRotationDevice,
  ChannelRotationWaveforms,
} from '../../chat/src/hooks/use-channel-rotation';
import type { DeviceClientFactory, RequestDeviceFn } from '../../chat/src/lib/bluetooth';
import type { WaveformDefinition } from '../../chat/src/lib/waveforms';
import { AuxDevices } from '@control/components/AuxDevices';
import { CoyoteSection } from '@control/components/CoyoteControl';
import { useChannelPlayback, startWaveformId } from '@control/hooks/use-playback';
import { useMomentaryFire } from '@control/hooks/use-momentary-fire';
import { attachedDeviceSummaries, holdsAnyDevice } from '@control/lib/attached-devices';

/**
 * Control — drive your own device, directly.
 *
 * No AI deciding anything, no room full of people, no game. The whole module is
 * one screen with the Coyote controls followed by auxiliary devices rather
 * than tabs, because the reason to open it is to reach a control right now.
 * Connection, disconnection and shared safety settings live in the shell's
 * one top device strip.
 *
 * Everything below the UI is borrowed rather than rebuilt: `useDevice` owns the
 * BLE session and the `DeviceCommandQueue` that every write goes through,
 * `useWaveforms` owns the shared library, and the caps come from
 * `@0xnullai/settings`. There is no second copy of the safety chain here — that
 * is the one thing this repo has decided may never be duplicated.
 */
export default function App() {
  // Android has no Web Bluetooth; the native shell injects a plugin-blec client
  // through NativeBridge. Control reuses Chat's seam because it runs on Chat's
  // DeviceSession — this is the same seam, not a fourth one.
  const native = useNativeBridge();
  const device = useDevice({
    clientFactory: native.chat?.deviceClientFactory as DeviceClientFactory | undefined,
    requestDevice: native.chat?.requestDevice as RequestDeviceFn | undefined,
  });
  const waveforms = useWaveforms();

  const playbackA = useChannelPlayback();
  const playbackB = useChannelPlayback();
  const [waveTab, setWaveTab] = useState<'A' | 'B'>('A');
  const [marketOpen, setMarketOpen] = useState(false);

  // Which host the shared waveform panel drives. Held as an id rather than an
  // index so unplugging one device does not silently re-point the panel at a
  // different one; the fallback below re-resolves to the primary only once the
  // selected host is actually gone.
  const [selectedCoyoteId, setSelectedCoyoteId] = useState<string | null>(null);
  const coyotes = device.coyotes;
  const selectedCoyote = coyotes.find((c) => c.id === selectedCoyoteId) ?? coyotes[0] ?? null;

  // The Opossum has caps of its own in the shared settings. They are read here
  // rather than borrowed from the Coyote's because setOpossumIntensity clamps
  // against these, and a ring showing a number that is not the enforced one is
  // a safety control that lies.
  const [opossumLimits, setOpossumLimits] = useState(() => {
    const safety = loadDeviceSafety();
    return { a: safety.maxIntensityA, b: safety.maxIntensityB };
  });
  useEffect(() => {
    const apply = () => {
      const safety = loadDeviceSafety();
      setOpossumLimits({ a: safety.maxIntensityA, b: safety.maxIntensityB });
    };
    apply();
    return subscribeDeviceSafety(apply);
  }, []);

  // Device control is a lease that follows the current module. Losing it has to
  // stop more than the output: the playlist timer is the one thing in here that
  // keeps running while the module is hidden, so it would happily issue a
  // setWave minutes after the user switched away. Tracking the lease lets it be
  // torn down at the moment control is handed over, instead of hoping the
  // waveform state goes quiet on its own.
  //
  // Read as "somebody else holds it" rather than "we do not hold it": nothing
  // has granted a lease before the shell's first effect runs, and standalone
  // mounts never grant one at all — treating that as "released" would leave the
  // module inert with no way to tell.
  const [released, setReleased] = useState(false);
  useEffect(() => {
    const sync = () => {
      const holder = currentDeviceLease();
      setReleased(holder !== null && holder !== 'control');
    };
    sync();
    return subscribeSafetySessions(sync);
  }, []);

  const {
    start: startFire,
    stop: stopFire,
    cancel: cancelFire,
    firingDeviceIds,
  } = useMomentaryFire({
    coyotes,
    released,
    setStrength: device.setStrength,
  });

  const stopAll = useCallback(() => {
    // Invalidate held-fire restoration before the queued emergency stop. A
    // pointerup delivered after the stop must never put the old baseline back.
    cancelFire();
    device.stopAll();
  }, [cancelFire, device]);

  const stopCoyote = useCallback(
    (deviceId: string) => {
      cancelFire(deviceId);
      device.stopCoyote(deviceId);
    },
    [cancelFire, device],
  );

  const disconnectCoyote = useCallback(
    (deviceId?: string) => {
      if (deviceId) cancelFire(deviceId);
      else cancelFire();
      device.disconnectCoyote(deviceId);
    },
    [cancelFire, device],
  );

  // Register on the global safety bus. This is the shell's only source for the
  // stop button and the device bar, and it must count every attached device —
  // an Opossum-only session that reports nothing leaves someone with a running
  // device and no stop button on screen.
  useSafetySession({
    id: 'control',
    label: 'Control',
    isActive: () => holdsAnyDevice(device),
    stop: stopAll,
    connect: device.connectDevice,
    disconnect: (deviceId) => {
      if (deviceId === 'opossum') return device.disconnectOpossum();
      if (deviceId === 'paw-prints' || deviceId === 'civet-edging') {
        return device.disconnectSensor();
      }
      return disconnectCoyote(deviceId);
    },
    onRevoke: () => {
      // Losing the lease means switching away from Control. Stop the output and
      // invalidate any held fire before its eventual pointerup can restore it.
      stopAll();
    },
    devices: () => attachedDeviceSummaries(device),
  });

  // The rotation timer reads the device and the library through refs so that a
  // strength change does not tear down and restart a 10-minute interval. An
  // effect is enough to keep them fresh: the timer fires minutes apart, so
  // being one commit behind cannot matter.
  //
  // It drives the *selected* host, the same one the waveform panel targets —
  // rotating a playlist on a device the panel is not pointing at would change
  // what somebody feels with nothing on screen indicating which device moved.
  const rotationDevice: ChannelRotationDevice = {
    connected: Boolean(selectedCoyote?.connected),
    setWave: (channel, frames, id, loop) =>
      device.setWave(channel, frames, id, loop, selectedCoyote?.id),
  };
  const deviceRef = useRef<ChannelRotationDevice>(rotationDevice);
  const waveformsRef = useRef<ChannelRotationWaveforms>(waveforms);
  useEffect(() => {
    deviceRef.current = rotationDevice;
    waveformsRef.current = waveforms;
  });

  useChannelRotation(
    'A',
    released ? null : (selectedCoyote?.waveIdA ?? null),
    playbackA.queue,
    playbackA.mode,
    playbackA.intervalSec,
    playbackA.setIndex,
    deviceRef,
    waveformsRef,
  );
  useChannelRotation(
    'B',
    released ? null : (selectedCoyote?.waveIdB ?? null),
    playbackB.queue,
    playbackB.mode,
    playbackB.intervalSec,
    playbackB.setIndex,
    deviceRef,
    waveformsRef,
  );

  /**
   * Press-and-hold strength.
   *
   * A press is a plain absolute setStrength, with no optimistic local value:
   * the device state is right here, one 100 ms protocol tick away, so the worst
   * a stale read can do is skip a step. It cannot overshoot — the target is
   * always derived from a value the device has already reported, and
   * DGLabDevice clamps it against the cap again on the way out.
   */
  const adjustStrength = useCallback(
    (deviceId: string, channel: 'A' | 'B', delta: number) => {
      if (released) return;
      // Read the target host's own strength and its own cap. Borrowing the
      // primary's would let a press on device #2's + button be computed
      // against device #1's reading — the one way two attached devices could
      // drive each other.
      const target = coyotes.find((c) => c.id === deviceId);
      if (!target) return;
      const current = channel === 'A' ? target.strengthA : target.strengthB;
      const limit = channel === 'A' ? target.limitA : target.limitB;
      const next = Math.max(0, Math.min(limit, current + delta));
      if (next === current) return;
      device.setStrength(channel, next, deviceId);
    },
    [coyotes, device, released],
  );

  const startChannel = useCallback(
    (deviceId: string, channel: 'A' | 'B', waveformId: string) => {
      if (released) return;
      const waveform = waveforms.getWaveform(waveformId);
      if (!waveform) return;
      device.setWave(channel, waveform.frames, waveform.id, true, deviceId);
    },
    [device, waveforms, released],
  );

  const togglePlay = useCallback(
    (deviceId: string, channel: 'A' | 'B') => {
      const playback = channel === 'A' ? playbackA : playbackB;
      const target = coyotes.find((c) => c.id === deviceId);
      const playing = channel === 'A' ? target?.waveActiveA : target?.waveActiveB;
      if (playing) {
        stopFire(channel);
        device.stopWave(channel, deviceId);
        return;
      }
      const id = startWaveformId(playback.queue, playback.index);
      if (id) startChannel(deviceId, channel, id);
    },
    [coyotes, device, playbackA, playbackB, startChannel, stopFire],
  );

  const toggleWaveform = useCallback(
    (waveform: WaveformDefinition) => {
      const playback = waveTab === 'A' ? playbackA : playbackB;
      const playing = waveTab === 'A' ? selectedCoyote?.waveActiveA : selectedCoyote?.waveActiveB;
      const added = !playback.queue.includes(waveform.id);
      playback.toggle(waveform.id);
      // Adding one while the channel is already running switches to it right
      // away — otherwise the tap looks like it did nothing until the next
      // rotation, which for a 10-minute interval reads as broken.
      if (added && playing && selectedCoyote) startChannel(selectedCoyote.id, waveTab, waveform.id);
    },
    [waveTab, playbackA, playbackB, selectedCoyote, startChannel],
  );

  const activePlayback = waveTab === 'A' ? playbackA : playbackB;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-6 px-4 py-5">
        <CoyoteSection
          coyotes={coyotes}
          selectedId={selectedCoyote?.id ?? null}
          onSelect={setSelectedCoyoteId}
          queueLengthA={playbackA.queue.length}
          queueLengthB={playbackB.queue.length}
          onAdjustStrength={adjustStrength}
          onTogglePlay={togglePlay}
          firingDeviceIdA={firingDeviceIds.A}
          firingDeviceIdB={firingDeviceIds.B}
          onFireStart={startFire}
          onFireStop={stopFire}
          onStopDevice={stopCoyote}
          onDisconnect={disconnectCoyote}
          // No device id: the module-level 归零 must cover every attached host
          // plus the Opossum, not whichever one happens to be selected.
          onStopAll={stopAll}
          waveTab={waveTab}
          onWaveTabChange={setWaveTab}
          waveforms={waveforms.allWaveforms}
          queue={activePlayback.queue}
          activeWaveId={
            waveTab === 'A' ? (selectedCoyote?.waveIdA ?? null) : (selectedCoyote?.waveIdB ?? null)
          }
          playMode={activePlayback.mode}
          intervalSec={activePlayback.intervalSec}
          onPlayModeChange={activePlayback.setMode}
          onIntervalChange={activePlayback.setIntervalSec}
          onToggleWaveform={toggleWaveform}
          onRemoveWaveform={waveforms.removeWaveform}
          onImportFile={waveforms.importFile}
          onOpenMarket={() => setMarketOpen(true)}
        />

        <AuxDevices
          sensor={device.sensor}
          opossum={device.opossum}
          opossumLimitA={opossumLimits.a}
          opossumLimitB={opossumLimits.b}
          onOpossumAdjust={(channel, delta) => {
            if (released) return;
            const current =
              channel === 'A'
                ? (device.opossum?.intensityA ?? 0)
                : (device.opossum?.intensityB ?? 0);
            device.setOpossumIntensity(channel, current + delta);
          }}
          onOpossumBurst={(channel, strength, durationMs) => {
            if (released) return;
            device.opossumBurst(channel, strength, durationMs);
          }}
          onOpossumStop={() => device.opossumStop()}
          onSetLedColor={device.setLedColor}
        />
      </div>

      <MarketImportDialog
        open={marketOpen}
        onOpenChange={setMarketOpen}
        type="waveform"
        onImport={waveforms.addMarketWaveform}
      />
    </div>
  );
}
