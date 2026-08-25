import type { DeviceSnapshot } from './contracts.js';
import type { DeviceRuntimeProvider, SharedDeviceRuntime } from './runtime-provider.js';
import type { BoundDeviceTools } from './tool-provider.js';

/**
 * Consumer-side binding for one feature module.
 *
 * It coalesces concurrent startup, follows the shell provider's current runtime, and owns exactly
 * one snapshot subscription. It does not request permissions, scan, reconnect, issue output, or
 * hide stop acknowledgements.
 */
export class DeviceRuntimeModuleBinding {
  private readonly listeners = new Set<(snapshot: DeviceSnapshot | null) => void>();
  private runtime: SharedDeviceRuntime | null = null;
  private boundTools: BoundDeviceTools | null = null;
  private opening: Promise<BoundDeviceTools> | null = null;
  private unsubscribeSnapshot: (() => void) | null = null;
  private disposed = false;
  private readonly provider: DeviceRuntimeProvider;
  private readonly moduleId: string;

  constructor(provider: DeviceRuntimeProvider, moduleId: string) {
    if (!moduleId) throw new Error('Device runtime module id must not be empty');
    this.provider = provider;
    this.moduleId = moduleId;
    const current = provider.current();
    if (current) this.bind(current);
  }

  snapshot(): DeviceSnapshot | null {
    const current = this.provider.current();
    return current ? current.snapshot() : null;
  }

  subscribe(listener: (snapshot: DeviceSnapshot | null) => void): () => void {
    this.requireActive();
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async tools(): Promise<BoundDeviceTools> {
    this.requireActive();
    const current = this.provider.current();
    if (current && current === this.runtime && this.boundTools) return this.boundTools;
    if (this.opening) return this.opening;

    const opening = this.provider.start().then((runtime) => {
      this.requireActive();
      if (this.provider.current() !== runtime) {
        throw new Error('Device runtime changed while binding module');
      }
      this.bind(runtime);
      return this.boundTools!;
    });
    this.opening = opening;
    try {
      return await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeSnapshot?.();
    this.unsubscribeSnapshot = null;
    this.runtime = null;
    this.boundTools = null;
    this.opening = null;
    this.listeners.clear();
  }

  private bind(runtime: SharedDeviceRuntime): void {
    if (this.runtime === runtime && this.boundTools) return;
    this.unsubscribeSnapshot?.();
    this.runtime = runtime;
    this.boundTools = runtime.forModule(this.moduleId);
    this.unsubscribeSnapshot = runtime.manager.subscribe((snapshot) => this.emit(snapshot));
    this.emit(runtime.snapshot());
  }

  private emit(snapshot: DeviceSnapshot | null): void {
    for (const listener of this.listeners) listener(snapshot);
  }

  private requireActive(): void {
    if (this.disposed) throw new Error('Device runtime module binding is disposed');
  }
}

/** Product-wide bounded interaction IDs for human and lifecycle runtime commands. */
export function createDeviceInteractionId(scope: string, action: string): string {
  if (!scope || !action) throw new Error('Device interaction scope and action must not be empty');
  const entropy =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${scope}/${action}/${entropy}`.slice(0, 128);
}
