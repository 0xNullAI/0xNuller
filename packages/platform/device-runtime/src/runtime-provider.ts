import type { DeviceBackend, DeviceRuntimeExecutorOptions, DeviceSnapshot } from './contracts.js';
import { DeviceRuntimeExecutor } from './executor.js';
import { DeviceRuntimeManager } from './manager.js';
import { type BoundDeviceTools, DeviceToolProvider } from './tool-provider.js';

export interface SharedDeviceRuntime {
  readonly manager: DeviceRuntimeManager;
  readonly executor: DeviceRuntimeExecutor;
  readonly toolProvider: DeviceToolProvider;
  snapshot(): DeviceSnapshot;
  forModule(moduleId: string): BoundDeviceTools;
}

export interface DeviceRuntimeProvider {
  current(): SharedDeviceRuntime | null;
  start(): Promise<SharedDeviceRuntime>;
  forModule(moduleId: string): Promise<BoundDeviceTools>;
}

export interface SharedDeviceRuntimeProviderOptions {
  backendFactory: () => DeviceBackend;
  executorOptions: DeviceRuntimeExecutorOptions;
}

/**
 * Shell-owned lifetime seam for Control, Agent, Voice, and Video.
 *
 * Calls made by multiple surfaces share one manager, executor, backend session,
 * lease boundary, watchdog set, and stop barrier. Reopening is always explicit.
 */
export class SharedDeviceRuntimeProvider implements DeviceRuntimeProvider {
  private runtime: SharedDeviceRuntime | null = null;
  private opening: Promise<SharedDeviceRuntime> | null = null;
  private readonly options: SharedDeviceRuntimeProviderOptions;

  constructor(options: SharedDeviceRuntimeProviderOptions) {
    this.options = options;
  }

  current(): SharedDeviceRuntime | null {
    return this.runtime;
  }

  async start(): Promise<SharedDeviceRuntime> {
    if (this.runtime) return this.runtime;
    if (this.opening) return this.opening;

    const manager = new DeviceRuntimeManager(this.options.backendFactory());
    const executor = new DeviceRuntimeExecutor(manager, this.options.executorOptions);
    const toolProvider = new DeviceToolProvider(manager, executor);
    const runtime: SharedDeviceRuntime = {
      manager,
      executor,
      toolProvider,
      snapshot: () => manager.snapshot(),
      forModule: (moduleId) => toolProvider.forModule(moduleId),
    };
    const opening = manager.start().then(() => runtime);
    this.opening = opening;

    try {
      const opened = await opening;
      if (this.opening === opening) this.runtime = opened;
      return opened;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  async forModule(moduleId: string): Promise<BoundDeviceTools> {
    return (await this.start()).forModule(moduleId);
  }

  async stop(): Promise<void> {
    const opening = this.opening;
    if (opening) {
      try {
        await opening;
      } catch {
        // A failed open owns no live backend session.
      }
    }
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) await runtime.manager.close();
  }

  async restart(): Promise<SharedDeviceRuntime> {
    await this.stop();
    return this.start();
  }
}
