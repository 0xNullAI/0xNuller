import type { RuntimeEvent } from '@dg-agent/core';

export type RuntimeListener = (event: RuntimeEvent) => void;

export class InMemoryEventBus {
  private listeners = new Set<RuntimeListener>();

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // A UI observer is not the owner of a physical stop command. Report
        // its failure without letting it interrupt subsequent listeners or
        // the runtime safety path that emitted this event.
        try {
          console.error('Agent runtime event listener failed', error);
        } catch {
          // Logging failure must not turn an observer into a device gate.
        }
      }
    }
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
