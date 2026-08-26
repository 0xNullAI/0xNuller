import type { DeviceBackend, DeviceRuntimeExecutorOptions } from './contracts.js';
import {
  type DeviceRuntimeProvider,
  type SharedDeviceRuntime,
  SharedDeviceRuntimeProvider,
} from './runtime-provider.js';
import type { BoundDeviceTools } from './tool-provider.js';
import {
  type LocalDeviceSettingStorage,
  readWebEmbeddedDevicesEnabled,
  writeWebEmbeddedDevicesEnabled,
} from './web-embedded-settings.js';

export class WebEmbeddedDevicesDisabledError extends Error {
  override readonly name = 'WebEmbeddedDevicesDisabledError';

  constructor() {
    super('experimental-embedded-devices-disabled');
  }
}

export class WebEmbeddedDeviceSettingError extends Error {
  override readonly name = 'WebEmbeddedDeviceSettingError';

  constructor() {
    super('embedded-device-local-setting-unavailable');
  }
}

export interface WebEmbeddedDeviceRuntimeProviderOptions {
  executorOptions: DeviceRuntimeExecutorOptions;
  storage?: LocalDeviceSettingStorage | null;
  /** Factory remains untouched until the local opt-in is enabled and a module starts the runtime. */
  backendFactory: () => DeviceBackend;
}

export interface EmbeddedDeviceRuntimeProvider extends DeviceRuntimeProvider {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): Promise<void>;
  subscribeEnabled(listener: (enabled: boolean) => void): () => void;
  stop(): Promise<void>;
  restart(): Promise<SharedDeviceRuntime>;
}

/** Default-off, browser-local owner for the single embedded device runtime. */
export class WebEmbeddedDeviceRuntimeProvider implements EmbeddedDeviceRuntimeProvider {
  private readonly storage: LocalDeviceSettingStorage | null | undefined;
  private readonly shared: SharedDeviceRuntimeProvider;
  private readonly settingListeners = new Set<(enabled: boolean) => void>();
  private disableFailure: unknown = null;

  constructor(options: WebEmbeddedDeviceRuntimeProviderOptions) {
    this.storage = options.storage;
    this.shared = new SharedDeviceRuntimeProvider({
      executorOptions: options.executorOptions,
      backendFactory: options.backendFactory,
    });
  }

  isEnabled(): boolean {
    return readWebEmbeddedDevicesEnabled(this.storage);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      if (this.disableFailure) throw this.disableFailure;
      try {
        await this.shared.stop();
      } catch (error) {
        // Do not let a second click clear the opt-in after an unconfirmed stop.
        // A full process reload is required to establish a fresh safety state.
        this.disableFailure = error;
        throw error;
      }
    }
    if (!writeWebEmbeddedDevicesEnabled(enabled, this.storage)) {
      throw new WebEmbeddedDeviceSettingError();
    }
    for (const listener of this.settingListeners) listener(enabled);
  }

  subscribeEnabled(listener: (enabled: boolean) => void): () => void {
    this.settingListeners.add(listener);
    return () => this.settingListeners.delete(listener);
  }

  current(): SharedDeviceRuntime | null {
    return this.shared.current();
  }

  async start(): Promise<SharedDeviceRuntime> {
    if (this.disableFailure) throw this.disableFailure;
    if (!this.isEnabled()) throw new WebEmbeddedDevicesDisabledError();
    return this.shared.start();
  }

  async forModule(moduleId: string): Promise<BoundDeviceTools> {
    return (await this.start()).forModule(moduleId);
  }

  async stop(): Promise<void> {
    await this.shared.stop();
  }

  async restart(): Promise<SharedDeviceRuntime> {
    if (this.disableFailure) throw this.disableFailure;
    if (!this.isEnabled()) throw new WebEmbeddedDevicesDisabledError();
    return this.shared.restart();
  }
}
