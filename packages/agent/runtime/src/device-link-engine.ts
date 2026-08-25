import type { DeviceLinkRule } from '@dg-agent/core';
import type { CivetPressureReading, OpossumButtonEvent, PawPrintsReading } from '@dg-kit/protocol';
import type { CivetEdgingClient, OpossumClient, PawPrintsClient } from './device-clients.js';

/**
 * Direct sensor → Opossum bridge for Agent. It is intentionally opt-in and
 * local: unlike a sensor-fired LLM turn, it never leaves the process and does
 * not involve a remote room member. Safety caps still live in the Opossum
 * client's command/policy layer.
 */
export class DeviceLinkEngine {
  private rule: DeviceLinkRule;
  private active = false;
  private lastFiredAt = Number.NEGATIVE_INFINITY;
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly options: {
      rule: DeviceLinkRule;
      opossum?: OpossumClient;
      pawPrints?: PawPrintsClient;
      civetEdging?: CivetEdgingClient;
      now?: () => number;
      canExecute?: () => boolean | Promise<boolean>;
    },
  ) {
    this.rule = { ...options.rule };
    const paw = options.pawPrints;
    const civet = options.civetEdging;
    if (paw) this.unsubscribers.push(paw.subscribe((reading) => this.onSensor(reading)));
    if (civet) this.unsubscribers.push(civet.subscribe((reading) => this.onSensor(reading)));
    if (options.opossum?.subscribeButtons) {
      this.unsubscribers.push(options.opossum.subscribeButtons((event) => this.onButton(event)));
    }
  }

  setRule(rule: DeviceLinkRule): void {
    this.rule = { ...rule };
    if (!rule.enabled) {
      this.active = false;
      this.clearPulseTimer();
      void this.stop();
    }
  }

  getRule(): DeviceLinkRule {
    return { ...this.rule };
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.clearPulseTimer();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  private onSensor(reading: PawPrintsReading | CivetPressureReading): void {
    if (!this.rule.enabled || this.rule.source === 'opossum-button') return;
    if (this.rule.source === 'paw-button') {
      if (reading.type === 'trigger') void this.fire();
      return;
    }
    if (reading.type !== 'pressure') return;
    if (!this.active && reading.kPa >= this.rule.thresholdKPa) {
      this.active = true;
      void this.fire();
    } else if (this.active && reading.kPa <= this.rule.releaseKPa) {
      this.active = false;
      void this.stop();
    }
  }

  private onButton(event: OpossumButtonEvent): void {
    if (this.rule.enabled && this.rule.source === 'opossum-button' && event.pressed.size > 0) {
      void this.fire();
    }
  }

  private async fire(): Promise<void> {
    const opossum = this.options.opossum;
    if (!opossum || !this.rule.enabled || this.disposed) return;
    if (this.options.canExecute && !(await this.options.canExecute())) return;
    // The gate may have yielded while a lease revocation/emergency stop disabled the rule.
    if (!this.rule.enabled || this.disposed) return;
    const now = this.options.now?.() ?? Date.now();
    if (now - this.lastFiredAt < this.rule.cooldownMs) return;
    this.lastFiredAt = now;
    const channels = this.rule.channel === 'both' ? (['A', 'B'] as const) : [this.rule.channel];
    for (const channel of channels) {
      void opossum.execute({ type: 'vibrateSetPattern', channel, pattern: this.rule.pattern });
      void opossum.execute({
        type: 'vibrateStart',
        channel,
        intensity: this.rule.intensity,
        pattern: this.rule.pattern,
      });
    }
    if (this.rule.source !== 'civet-pressure') {
      this.clearPulseTimer();
      this.pulseTimer = setTimeout(() => {
        this.pulseTimer = null;
        void this.stop();
      }, 500);
    }
  }

  private async stop(): Promise<void> {
    this.clearPulseTimer();
    const opossum = this.options.opossum;
    if (!opossum) return;
    await opossum.execute({ type: 'vibrateStop' });
  }

  private clearPulseTimer(): void {
    if (this.pulseTimer == null) return;
    clearTimeout(this.pulseTimer);
    this.pulseTimer = null;
  }
}
