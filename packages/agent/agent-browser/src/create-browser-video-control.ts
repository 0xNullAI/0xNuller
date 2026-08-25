import type { DeviceClient, DeviceState, LlmClient, LlmImageInput } from '@dg-agent/core';
import { createEmptyDeviceState } from '@dg-agent/core';
import {
  CoyoteProtocolAdapter,
  createEmptyOpossumState,
  type OpossumState,
} from '@dg-kit/protocol';
import { hasDeviceLease, type DeviceSummary } from '@dg-kit/safety';
import {
  WebBluetoothDeviceClient,
  WebBluetoothOpossumClient,
} from '@dg-kit/transport-webbluetooth';
import {
  VideoControlRuntime,
  getAnyPromptPresetById,
  type VideoControlGrantInput,
  type VideoControlGrantSnapshot,
  type VideoControlRuntimeOptions,
  type OpossumClient,
  type VideoControlSafetyLimits,
} from '@dg-agent/runtime';
import { BrowserWaveformLibrary } from '@dg-agent/waveforms';
import { connectAnyDgLabDevice } from './connect-any-device.js';

export interface BrowserVideoSceneLibrary {
  selectedId: string;
  scenes: Array<{ id: string; name: string; prompt: string; icon?: string }>;
}

export interface BrowserVideoControlOptions {
  getLlm: () => LlmClient | null;
  getSafetyLimits: () => VideoControlSafetyLimits;
  getSceneLibrary?: () => BrowserVideoSceneLibrary;
  hasLease?: () => boolean;
  onEffectSettled?: VideoControlRuntimeOptions['onEffectSettled'];
  /** Native shells inject Tauri clients; web defaults to Web Bluetooth. */
  device?: DeviceClient;
  opossum?: OpossumClient;
  connectOutputDevice?: (clients: {
    device: DeviceClient;
    opossum: OpossumClient;
  }) => Promise<{ kind: string; name: string }>;
}

export interface BrowserVideoControlInputs {
  llm: LlmClient | null;
  safetyLimits: VideoControlSafetyLimits;
  sceneLibrary?: BrowserVideoSceneLibrary;
}

export interface BrowserVideoDeviceSnapshot {
  coyote: DeviceState;
  opossum: OpossumState;
}

export type VideoOutputKind = 'coyote' | 'opossum';

/** Browser transport composition behind a Video-specific, narrow API. */
export class BrowserVideoControlService {
  private readonly device: DeviceClient;
  private readonly opossum: OpossumClient;
  private readonly runtime: VideoControlRuntime;
  private readonly connectOutputDevice: BrowserVideoControlOptions['connectOutputDevice'];
  private readonly listeners = new Set<(snapshot: BrowserVideoDeviceSnapshot) => void>();
  private llm: LlmClient | null;
  private safetyLimits: VideoControlSafetyLimits;
  private sceneLibrary: BrowserVideoSceneLibrary | undefined;
  private snapshot: BrowserVideoDeviceSnapshot = {
    coyote: createEmptyDeviceState(),
    opossum: createEmptyOpossumState(),
  };

  constructor(options: BrowserVideoControlOptions) {
    this.device =
      options.device ??
      new WebBluetoothDeviceClient({
        protocol: new CoyoteProtocolAdapter(),
      });
    this.opossum = options.opossum ?? new WebBluetoothOpossumClient();
    this.connectOutputDevice = options.connectOutputDevice;
    this.llm = options.getLlm();
    this.safetyLimits = options.getSafetyLimits();
    this.sceneLibrary = options.getSceneLibrary?.();
    this.runtime = new VideoControlRuntime({
      device: this.device,
      opossum: this.opossum,
      getLlm: () => this.llm,
      getSafetyLimits: () => this.safetyLimits,
      getScene: () => {
        const library = this.sceneLibrary;
        if (!library) return null;
        const selected = getAnyPromptPresetById(library.selectedId, library.scenes);
        return selected ? { name: selected.name, prompt: selected.prompt } : null;
      },
      hasLease: options.hasLease ?? (() => hasDeviceLease('video')),
      waveformLibrary: new BrowserWaveformLibrary(),
      onEffectSettled: options.onEffectSettled,
    });
    this.device.onStateChanged((state) => {
      this.snapshot = { ...this.snapshot, coyote: { ...state } };
      this.emit();
    });
    this.opossum.onStateChanged((state) => {
      this.snapshot = { ...this.snapshot, opossum: { ...state } };
      this.emit();
    });
    void this.refresh();
  }

  updateInputs(inputs: BrowserVideoControlInputs): void {
    this.llm = inputs.llm;
    this.safetyLimits = inputs.safetyLimits;
    this.sceneLibrary = inputs.sceneLibrary;
  }

  getSnapshot(): BrowserVideoDeviceSnapshot {
    return {
      coyote: { ...this.snapshot.coyote },
      opossum: { ...this.snapshot.opossum },
    };
  }

  subscribe(listener: (snapshot: BrowserVideoDeviceSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  async connect(kind?: VideoOutputKind): Promise<VideoOutputKind> {
    if (kind === 'coyote') {
      await this.device.connect();
      await this.refresh();
      return kind;
    }
    if (kind === 'opossum') {
      await this.opossum.connect();
      await this.refresh();
      return kind;
    }
    const result = this.connectOutputDevice
      ? await this.connectOutputDevice({ device: this.device, opossum: this.opossum })
      : await connectAnyDgLabDevice({
          device: this.device,
          opossum: this.opossum,
        });
    if (result.kind !== 'coyote' && result.kind !== 'opossum') {
      throw new Error('Video 仅支持郊狼与负鼠输出设备');
    }
    await this.refresh();
    return result.kind;
  }

  async disconnect(kind: VideoOutputKind): Promise<void> {
    await (kind === 'coyote' ? this.device.disconnect() : this.opossum.disconnect());
    await this.refresh();
  }

  getDeviceSummaries(safety: VideoControlSafetyLimits): DeviceSummary[] {
    const out: DeviceSummary[] = [];
    const coyote = this.snapshot.coyote;
    if (coyote.connected) {
      out.push({
        id: 'coyote',
        kind: 'coyote',
        name: '郊狼',
        connected: true,
        battery: coyote.battery,
        active: coyote.strengthA > 0 || coyote.strengthB > 0,
        channels: [
          { label: 'A', value: coyote.strengthA, max: safety.maxStrengthA },
          { label: 'B', value: coyote.strengthB, max: safety.maxStrengthB },
        ],
      });
    }
    const opossum = this.snapshot.opossum;
    if (opossum.connected) {
      out.push({
        id: 'opossum',
        kind: 'opossum',
        name: opossum.deviceName ?? '负鼠',
        connected: true,
        battery: opossum.battery,
        active: opossum.intensityA > 0 || opossum.intensityB > 0,
        channels: [
          { label: 'A', value: opossum.intensityA, max: safety.maxIntensityA },
          { label: 'B', value: opossum.intensityB, max: safety.maxIntensityB },
        ],
      });
    }
    return out;
  }

  authorize(input: VideoControlGrantInput): Promise<VideoControlGrantSnapshot> {
    return this.runtime.authorize(input);
  }

  getGrant(): VideoControlGrantSnapshot | null {
    return this.runtime.getGrant();
  }

  beginRun(): number {
    return this.runtime.beginRun();
  }

  observe(image: LlmImageInput, signal?: AbortSignal): Promise<string> {
    return this.runtime.observe(image, signal);
  }

  stop(reason: Parameters<VideoControlRuntime['stop']>[0]): Promise<void> {
    return this.runtime.stop(reason);
  }

  emergencyStop(): Promise<void> {
    return this.runtime.emergencyStop();
  }

  isEmergencyLatched(): boolean {
    return this.runtime.isEmergencyLatched();
  }

  async dispose(): Promise<void> {
    // Keep transport-state listeners attached: React Strict Mode performs an
    // immediate setup → cleanup → setup cycle on first mount, and the same
    // service instance must remain usable for the second setup. Runtime stop
    // is idempotent and still aborts inference/effects and zeros the grant.
    this.listeners.clear();
    await this.runtime.dispose();
  }

  private async refresh(): Promise<void> {
    const [coyote, opossum] = await Promise.all([this.device.getState(), this.opossum.getState()]);
    this.snapshot = { coyote, opossum };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function createBrowserVideoControl(
  options: BrowserVideoControlOptions,
): BrowserVideoControlService {
  return new BrowserVideoControlService(options);
}
