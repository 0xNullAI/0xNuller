import type { DeviceBackend, DeviceRuntimeExecutorOptions } from './contracts.js';
import { type SharedDeviceRuntime, SharedDeviceRuntimeProvider } from './runtime-provider.js';
import type { BoundDeviceTools } from './tool-provider.js';
import {
  WebEmbeddedButtplugBackend,
  type WebEmbeddedButtplugBackendOptions,
} from './web-buttplug-backend.js';
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
  backendOptions?: WebEmbeddedButtplugBackendOptions;
  /** @internal Allows deterministic provider tests without a browser or hardware. */
  backendFactory?: () => DeviceBackend;
}

/** Default-off, browser-local owner for the single embedded device runtime. */
export class WebEmbeddedDeviceRuntimeProvider {
  private readonly storage: LocalDeviceSettingStorage | null | undefined;
  private readonly shared: SharedDeviceRuntimeProvider;

  constructor(options: WebEmbeddedDeviceRuntimeProviderOptions) {
    this.storage = options.storage;
    this.shared = new SharedDeviceRuntimeProvider({
      executorOptions: options.executorOptions,
      backendFactory:
        options.backendFactory ?? (() => new WebEmbeddedButtplugBackend(options.backendOptions)),
    });
  }

  isEnabled(): boolean {
    return readWebEmbeddedDevicesEnabled(this.storage);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) await this.shared.stop();
    if (!writeWebEmbeddedDevicesEnabled(enabled, this.storage)) {
      throw new WebEmbeddedDeviceSettingError();
    }
  }

  current(): SharedDeviceRuntime | null {
    return this.shared.current();
  }

  async start(): Promise<SharedDeviceRuntime> {
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
    if (!this.isEnabled()) throw new WebEmbeddedDevicesDisabledError();
    return this.shared.restart();
  }
}
