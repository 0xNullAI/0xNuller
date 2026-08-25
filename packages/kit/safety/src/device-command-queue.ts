import type { DeviceClient, OpossumCommand } from '@dg-kit/core';
import type { DeviceCommand, DeviceCommandResult } from '@dg-kit/core';
import type { OpossumClient, OpossumCommandResult } from '@dg-kit/protocol';

export interface PriorityInterrupt<TCommand, TResult> {
  /** Which command(s) should bypass the queue and run immediately. */
  matches(command: TCommand): boolean;
  /** How to actually run a matched command (typically not via `execute()`). */
  run(command: TCommand): Promise<TResult>;
  /** Result for a task that was already queued when a later interrupt fired. */
  skippedResult(): Promise<TResult>;
}

export interface SerialCommandQueueOptions<TCommand, TResult> {
  execute(command: TCommand): Promise<TResult>;
  /** Omit for a plain FIFO queue with no priority-interrupt concept. */
  priorityInterrupt?: PriorityInterrupt<TCommand, TResult>;
}

/**
 * Runs commands against a device one at a time, so concurrent tool calls
 * can't race each other's writes — a rejected command doesn't jam the
 * queue, the next enqueued command still runs.
 *
 * An optional `priorityInterrupt` lets one command "type" (Coyote's
 * `emergencyStop`) skip the line entirely: it bumps a generation counter
 * and runs immediately via `run()` rather than `execute()`, and any
 * already-queued-but-not-yet-run task notices its generation is stale and
 * resolves with `skippedResult()` instead of actually executing. The public
 * `interrupt()` method provides the same protection for out-of-band stops,
 * including Opossum's runtime-wide emergency stop.
 */
export class SerialCommandQueue<TCommand, TResult> {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private activeInterrupt: Pick<
    PriorityInterrupt<TCommand, TResult>,
    'run' | 'skippedResult'
  > | null = null;

  constructor(private readonly options: SerialCommandQueueOptions<TCommand, TResult>) {}

  async enqueue(command: TCommand): Promise<TResult> {
    const interrupt = this.options.priorityInterrupt;
    if (interrupt?.matches(command)) {
      return this.interrupt(() => interrupt.run(command), interrupt.skippedResult);
    }

    const generation = this.generation;

    const task = this.tail.then(async () => {
      if (generation !== this.generation && this.activeInterrupt) {
        return this.activeInterrupt.skippedResult();
      }

      const startedAt = this.generation;
      const result = await this.options.execute(command);

      // An emergency stop happened *while the command was executing*: it was
      // already in flight, so the generation check can't catch it — the check
      // runs before execute, and the stop runs concurrently. Its write lands
      // after the stop, so the device halts and then jumps back to the
      // previous strength. Observed exactly in that order (stop → in-flight
      // +10 lands → strength 10).
      //
      // A packet already sent cannot be recalled; what we can do is stop
      // again right after. Emergency stop must be idempotent, so a duplicate
      // stop is safe — a missed one is not.
      if (startedAt !== this.generation && this.activeInterrupt) {
        await this.activeInterrupt.run(command);
        return this.activeInterrupt.skippedResult();
      }

      return result;
    });

    this.tail = task.then(
      () => undefined,
      () => undefined,
    );

    return task;
  }

  /**
   * Preempts queued work and invalidates an already-running continuation.
   * The interrupt runs immediately; if an older command completes later,
   * the queue runs it once more to restore the safe state.
   */
  async interrupt(
    run: () => Promise<TResult>,
    skippedResult: () => Promise<TResult>,
  ): Promise<TResult> {
    this.generation += 1;
    this.activeInterrupt = {
      run: () => run(),
      skippedResult,
    };
    return run();
  }
}

export class DeviceCommandQueue {
  private readonly queue: SerialCommandQueue<DeviceCommand, DeviceCommandResult>;

  constructor(private readonly device: DeviceClient) {
    this.queue = new SerialCommandQueue({
      execute: (command) => this.device.execute(command),
      priorityInterrupt: {
        matches: (command) => command.type === 'emergencyStop',
        run: async () => {
          await this.device.emergencyStop();
          return {
            state: await this.device.getState(),
            notes: ['queue-drained-by-emergency-stop'],
          };
        },
        skippedResult: async () => ({
          state: await this.device.getState(),
          notes: ['skipped-after-priority-interrupt'],
        }),
      },
    });
  }

  async enqueue(command: DeviceCommand): Promise<DeviceCommandResult> {
    return this.queue.enqueue(command);
  }

  async emergencyStop(): Promise<DeviceCommandResult> {
    return this.enqueue({ type: 'emergencyStop' });
  }
}

/**
 * Serializes Opossum vibration commands and exposes an out-of-band emergency
 * interrupt. The interrupt uses the same generation preemption as Coyote, so
 * queued work is skipped and an in-flight write that lands late is followed
 * by another stop instead of restoring vibration.
 */
export class OpossumCommandQueue {
  private readonly queue: SerialCommandQueue<OpossumCommand, OpossumCommandResult>;

  constructor(private readonly device: OpossumClient) {
    this.queue = new SerialCommandQueue({
      execute: (command) => this.device.execute(command),
    });
  }

  async enqueue(command: OpossumCommand): Promise<OpossumCommandResult> {
    return this.queue.enqueue(command);
  }

  async emergencyStop(): Promise<OpossumCommandResult> {
    const stoppedResult = async (): Promise<OpossumCommandResult> => ({
      state: await this.device.getState(),
    });
    return this.queue.interrupt(async () => {
      await this.device.emergencyStop();
      return stoppedResult();
    }, stoppedResult);
  }
}
