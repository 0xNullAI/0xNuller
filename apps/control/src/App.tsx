import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  isWaveformCompatibleWithDevice,
  type WaveformDefinition,
  type WaveformModality,
} from '@dg-kit/core';
import {
  OutputDeviceSection,
  type OutputPanelState,
  type OutputTarget,
} from '@control/components/OutputDeviceSection';
import { EmbeddedDevicePanel } from '@control/components/EmbeddedDevicePanel';
import { startWaveformId } from '@control/hooks/use-playback';
import { useDevicePlayback } from '@control/hooks/use-device-playback';
import { useMomentaryFire } from '@control/hooks/use-momentary-fire';
import { attachedDeviceSummaries, holdsAnyDevice } from '@0xnullai/device-runtime';

// A value of 5 becomes a B0 ceiling of only 2.5/100 in the Opossum protocol,
// which is below the physical start threshold of many vibration motors. Start
// at a clearly perceptible but still safety-capped level instead.
const DEFAULT_OPOSSUM_START_INTENSITY = 30;

function waveformsForOutput(
  target: OutputTarget | null,
  allWaveforms: WaveformDefinition[],
): WaveformDefinition[] {
  // A Coyote consumes electrostimulation definitions; an Opossum consumes
  // vibration envelopes. Legacy definitions without a modality remain
  // electrostimulation for backwards compatibility.
  return allWaveforms.filter((waveform) =>
    isWaveformCompatibleWithDevice(target?.kind ?? 'coyote', waveform),
  );
}

function playbackIdForTarget(target: OutputTarget | null): string | null {
  // Waveform definitions are shared by modality through useWaveforms, but
  // playback state belongs to the physical output. Never key two Coyotes to
  // one playlist: their queue, mode, interval and current index are separate.
  return target?.id ?? null;
}

/**
 * Control — drive your own device, directly.
 *
 * No AI deciding anything, no room full of people, no game. The whole module is
 * one screen of complete device pages: each output owns its two channels,
 * waveform library and fire controls, and the pages move horizontally when
 * more than one device is attached. Connection, disconnection and shared
 * safety settings live in the shell's one top device strip.
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

  const devicePlayback = useDevicePlayback();
  // Each physical output page remembers its own channel tab and playback state.
  // The waveform definitions themselves come from the shared, modality-aware
  // library; queue/mode/interval state is intentionally per device.
  const [waveTabs, setWaveTabs] = useState<Record<string, 'A' | 'B'>>({});
  const [marketOpen, setMarketOpen] = useState(false);
  const [marketModality, setMarketModality] = useState<WaveformModality>('electrostimulation');

  // Which output host the shared console drives. Sensors deliberately never
  // enter this deck; their one useful value lives in the global device bar.
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(null);
  const coyotes = device.coyotes;

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

  const outputTargets = useMemo<OutputTarget[]>(
    () => [
      ...coyotes.map((coyote, index) => ({
        id: `coyote:${coyote.id}`,
        kind: 'coyote' as const,
        label: coyotes.length > 1 ? `郊狼 ${index + 1}` : '郊狼',
        coyote,
      })),
      ...(device.opossum?.connected
        ? [
            {
              id: 'opossum' as const,
              kind: 'opossum' as const,
              label: '负鼠',
              opossum: device.opossum,
              limitA: opossumLimits.a,
              limitB: opossumLimits.b,
            },
          ]
        : []),
    ],
    [coyotes, device.opossum, opossumLimits],
  );
  const selectedOutput =
    outputTargets.find((target) => target.id === selectedOutputId) ?? outputTargets[0] ?? null;
  const selectedCoyote = selectedOutput?.kind === 'coyote' ? selectedOutput.coyote : null;
  const selectedPlaybackId = playbackIdForTarget(selectedOutput);
  const playbackA = devicePlayback.get(selectedPlaybackId, 'A');
  const playbackB = devicePlayback.get(selectedPlaybackId, 'B');

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
  const [opossumFiring, setOpossumFiring] = useState<Record<'A' | 'B', boolean>>({
    A: false,
    B: false,
  });
  const opossumFireBaseline = useRef<Record<'A' | 'B', number>>({ A: 0, B: 0 });

  const stopOpossumFire = useCallback(
    (channel: 'A' | 'B') => {
      if (!opossumFiring[channel]) return;
      device.setOpossumIntensity(channel, opossumFireBaseline.current[channel]);
      setOpossumFiring((current) => ({ ...current, [channel]: false }));
    },
    [device, opossumFiring],
  );

  const stopAll = useCallback(() => {
    // Invalidate held-fire restoration before the queued emergency stop. A
    // pointerup delivered after the stop must never put the old baseline back.
    cancelFire();
    setOpossumFiring({ A: false, B: false });
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
  // It drives the selected host. The queue is shared by Coyotes, but output
  // remains addressed to the page's specific Bluetooth device.
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

  const adjustOutput = useCallback(
    (targetId: string, channel: 'A' | 'B', delta: number) => {
      if (released) return;
      const target = outputTargets.find((candidate) => candidate.id === targetId);
      if (!target) return;
      if (target.kind === 'coyote') {
        adjustStrength(target.coyote.id, channel, delta);
        return;
      }
      const current = channel === 'A' ? target.opossum.intensityA : target.opossum.intensityB;
      device.setOpossumIntensity(channel, current + delta);
    },
    [adjustStrength, device, outputTargets, released],
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
    (targetId: string, channel: 'A' | 'B') => {
      const target = outputTargets.find((candidate) => candidate.id === targetId);
      if (!target) return;
      const playback = devicePlayback.get(targetId, channel);
      if (target.kind === 'opossum') {
        const intensity = channel === 'A' ? target.opossum.intensityA : target.opossum.intensityB;
        if (intensity > 0) {
          stopOpossumFire(channel);
          device.opossumStop(channel);
          return;
        }
        const id = startWaveformId(playback.queue, playback.index);
        const waveform = id ? waveforms.getWaveform(id) : null;
        if (waveform?.modality === 'vibration') {
          device.setOpossumWaveform(channel, waveform.frames, waveform.id);
        } else return;
        const limit = channel === 'A' ? opossumLimits.a : opossumLimits.b;
        device.setOpossumIntensity(channel, Math.min(limit, DEFAULT_OPOSSUM_START_INTENSITY));
        return;
      }
      const coyote = target.coyote;
      const playing = channel === 'A' ? coyote.waveActiveA : coyote.waveActiveB;
      if (playing) {
        stopFire(channel);
        device.stopWave(channel, coyote.id);
        return;
      }
      const id = startWaveformId(playback.queue, playback.index);
      if (id) startChannel(coyote.id, channel, id);
    },
    [
      device,
      devicePlayback,
      opossumLimits,
      outputTargets,
      startChannel,
      stopFire,
      stopOpossumFire,
      waveforms,
    ],
  );

  const toggleWaveform = useCallback(
    (targetId: string, channel: 'A' | 'B', waveform: WaveformDefinition) => {
      const target = outputTargets.find((candidate) => candidate.id === targetId);
      if (!target || (waveform.modality === 'vibration') !== (target.kind === 'opossum')) return;
      const playback = devicePlayback.get(targetId, channel);
      const playing =
        target.kind === 'coyote'
          ? channel === 'A'
            ? target.coyote.waveActiveA
            : target.coyote.waveActiveB
          : (channel === 'A' ? target.opossum.intensityA : target.opossum.intensityB) > 0;
      const added = !playback.queue.includes(waveform.id);
      playback.toggle(waveform.id);
      // Adding one while the channel is already running switches to it right
      // away — otherwise the tap looks like it did nothing until the next
      // rotation, which for a 10-minute interval reads as broken.
      if (added && playing && target.kind === 'coyote') {
        startChannel(target.coyote.id, channel, waveform.id);
      } else if (added && playing && target.kind === 'opossum') {
        device.setOpossumWaveform(channel, waveform.frames, waveform.id);
      }
    },
    [device, devicePlayback, outputTargets, startChannel],
  );

  const startOutputFire = useCallback(
    (targetId: string, channel: 'A' | 'B', boost: number) => {
      if (released) return;
      const target = outputTargets.find((candidate) => candidate.id === targetId);
      if (!target) return;
      if (target.kind === 'coyote') {
        startFire(target.coyote.id, channel, boost);
        return;
      }
      const current = channel === 'A' ? target.opossum.intensityA : target.opossum.intensityB;
      opossumFireBaseline.current[channel] = current;
      device.setOpossumIntensity(channel, current + boost);
      setOpossumFiring((state) => ({ ...state, [channel]: true }));
    },
    [device, outputTargets, released, startFire],
  );

  const stopOutputFire = useCallback(
    (targetId: string, channel: 'A' | 'B') => {
      const target = outputTargets.find((candidate) => candidate.id === targetId);
      if (target?.kind === 'coyote') stopFire(channel);
      if (target?.kind === 'opossum') stopOpossumFire(channel);
    },
    [outputTargets, stopFire, stopOpossumFire],
  );

  const panelForTarget = (target: OutputTarget): OutputPanelState => {
    const playbackId = playbackIdForTarget(target);
    const playbackAForTarget = devicePlayback.get(playbackId, 'A');
    const playbackBForTarget = devicePlayback.get(playbackId, 'B');
    const tab = waveTabs[target.id] ?? 'A';
    const activePlayback = tab === 'A' ? playbackAForTarget : playbackBForTarget;
    const compatibleWaveforms = waveformsForOutput(target, waveforms.allWaveforms);

    return {
      waveTab: tab,
      onWaveTabChange: (channel) =>
        setWaveTabs((current) => ({ ...current, [target.id]: channel })),
      waveforms: compatibleWaveforms,
      queue: activePlayback.queue,
      queueA: playbackAForTarget.queue,
      queueB: playbackBForTarget.queue,
      activeWaveId:
        target.kind === 'coyote'
          ? tab === 'A'
            ? target.coyote.waveIdA
            : target.coyote.waveIdB
          : tab === 'A'
            ? target.opossum.waveIdA
            : target.opossum.waveIdB,
      playMode: activePlayback.mode,
      intervalSec: activePlayback.intervalSec,
      onPlayModeChange: activePlayback.setMode,
      onIntervalChange: activePlayback.setIntervalSec,
      onToggleWaveform: (waveform) => toggleWaveform(target.id, tab, waveform),
      onRemoveWaveform: waveforms.removeWaveform,
      onImportFile: waveforms.importFile,
      onOpenMarket: () => {
        setMarketModality(target.kind === 'opossum' ? 'vibration' : 'electrostimulation');
        setMarketOpen(true);
      },
      fireEnabledA:
        target.kind === 'coyote'
          ? Boolean(target.coyote.connected && target.coyote.waveActiveA)
          : true,
      fireEnabledB:
        target.kind === 'coyote'
          ? Boolean(target.coyote.connected && target.coyote.waveActiveB)
          : true,
      fireLimitA: target.kind === 'coyote' ? target.coyote.limitA : target.limitA,
      fireLimitB: target.kind === 'coyote' ? target.coyote.limitB : target.limitB,
      firingA: target.kind === 'coyote' ? firingDeviceIds.A === target.coyote.id : opossumFiring.A,
      firingB: target.kind === 'coyote' ? firingDeviceIds.B === target.coyote.id : opossumFiring.B,
      onFireStart: (channel, boost) => startOutputFire(target.id, channel, boost),
      onFireStop: (channel) => stopOutputFire(target.id, channel),
    };
  };

  const emptyPlaybackA = devicePlayback.get(null, 'A');
  const emptyPlaybackB = devicePlayback.get(null, 'B');
  const emptyTab = waveTabs.__none__ ?? 'A';
  const emptyActivePlayback = emptyTab === 'A' ? emptyPlaybackA : emptyPlaybackB;
  const emptyPanel: OutputPanelState = {
    waveTab: emptyTab,
    onWaveTabChange: (channel) => setWaveTabs((current) => ({ ...current, __none__: channel })),
    waveforms: waveformsForOutput(null, waveforms.allWaveforms),
    queue: emptyActivePlayback.queue,
    queueA: emptyPlaybackA.queue,
    queueB: emptyPlaybackB.queue,
    activeWaveId: null,
    playMode: emptyActivePlayback.mode,
    intervalSec: emptyActivePlayback.intervalSec,
    onPlayModeChange: emptyActivePlayback.setMode,
    onIntervalChange: emptyActivePlayback.setIntervalSec,
    onToggleWaveform: () => undefined,
    onRemoveWaveform: waveforms.removeWaveform,
    onImportFile: waveforms.importFile,
    onOpenMarket: () => {
      setMarketModality('electrostimulation');
      setMarketOpen(true);
    },
    fireEnabledA: false,
    fireEnabledB: false,
    fireLimitA: 0,
    fireLimitB: 0,
    firingA: false,
    firingB: false,
    onFireStart: () => undefined,
    onFireStop: () => undefined,
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-3 py-5 sm:px-4">
        <EmbeddedDevicePanel />

        <OutputDeviceSection
          targets={outputTargets}
          selected={selectedOutput}
          onSelect={(id) => {
            stopFire('A');
            stopFire('B');
            stopOpossumFire('A');
            stopOpossumFire('B');
            setSelectedOutputId(id);
          }}
          panelForTarget={panelForTarget}
          emptyPanel={emptyPanel}
          onAdjust={adjustOutput}
          onTogglePlay={togglePlay}
          onStop={(targetId) => {
            const target = outputTargets.find((candidate) => candidate.id === targetId);
            if (target?.kind === 'coyote') stopCoyote(target.coyote.id);
            if (target?.kind === 'opossum') {
              stopOpossumFire('A');
              stopOpossumFire('B');
              device.opossumStop();
            }
          }}
          onDisconnect={(targetId) => {
            const target = outputTargets.find((candidate) => candidate.id === targetId);
            if (target?.kind === 'coyote') disconnectCoyote(target.coyote.id);
            if (target?.kind === 'opossum') device.disconnectOpossum();
          }}
        />
      </div>

      <MarketImportDialog
        open={marketOpen}
        onOpenChange={setMarketOpen}
        type="waveform"
        modality={marketModality}
        onImport={waveforms.addMarketWaveform}
      />
    </div>
  );
}
