import type { Channel, DeviceKind } from '@dg-agent/core';
import type { DeviceExecutionGateInput } from './runtime-tool-executor.js';

export const VIDEO_CONTROL_MAX_DURATION_MS = 15 * 60 * 1000;
export const VIDEO_CONTROL_MIN_CADENCE_MS = 5_000;
export const VIDEO_CONTROL_MAX_CADENCE_MS = 30_000;
export const VIDEO_CONTROL_MIN_CAPTURE_INTERVAL_MS = 200;
export const VIDEO_CONTROL_MAX_CAPTURE_INTERVAL_MS = 5_000;
export const VIDEO_CONTROL_MAX_INTENSITY = 200;

export type VideoControlTargetKind = Extract<DeviceKind, 'coyote' | 'opossum'>;

export interface VideoControlGrantInput {
  targetKind: VideoControlTargetKind;
  /** Opaque identity for one physical connection; never persisted or reused. */
  targetId: string;
  channel: Channel;
  intensityCap: number;
  /** Allows positive adjustments after the initial, safety-capped start. */
  allowEnhanced: boolean;
  allowBurst: boolean;
  durationMs: number;
  cadenceMs: number;
  /** Local latest-frame refresh rate; model requests remain cadence-limited separately. */
  captureIntervalMs: number;
}

export interface VideoControlGrantSnapshot extends VideoControlGrantInput {
  id: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface VideoControlGrantOptions {
  now?: () => number;
  safetyIntensityCap?: number;
}

/**
 * Process-local authorization for one Video output target and channel.
 * Camera control grants are deliberately neither serializable nor renewable:
 * continuing always requires the same live page and an unexpired grant.
 */
export class VideoControlGrant {
  private revoked = false;
  private readonly now: () => number;
  private readonly snapshot: Omit<VideoControlGrantSnapshot, 'revoked'>;

  constructor(input: VideoControlGrantInput, options: VideoControlGrantOptions = {}) {
    this.now = options.now ?? Date.now;
    const issuedAt = this.now();
    const durationMs = clampInteger(input.durationMs, 1_000, VIDEO_CONTROL_MAX_DURATION_MS);
    const safetyCap = clampInteger(
      options.safetyIntensityCap ?? VIDEO_CONTROL_MAX_INTENSITY,
      0,
      VIDEO_CONTROL_MAX_INTENSITY,
    );
    this.snapshot = {
      id: `video-grant-${issuedAt}-${Math.random().toString(36).slice(2, 8)}`,
      targetKind: input.targetKind,
      targetId: requireTargetId(input.targetId),
      channel: input.channel === 'B' ? 'B' : 'A',
      intensityCap: clampInteger(input.intensityCap, 0, safetyCap),
      allowEnhanced: input.allowEnhanced === true,
      allowBurst: input.allowBurst === true,
      durationMs,
      cadenceMs: clampInteger(
        input.cadenceMs,
        VIDEO_CONTROL_MIN_CADENCE_MS,
        VIDEO_CONTROL_MAX_CADENCE_MS,
      ),
      captureIntervalMs: clampInteger(
        input.captureIntervalMs,
        VIDEO_CONTROL_MIN_CAPTURE_INTERVAL_MS,
        VIDEO_CONTROL_MAX_CAPTURE_INTERVAL_MS,
      ),
      issuedAt,
      expiresAt: issuedAt + durationMs,
    };
  }

  getSnapshot(): VideoControlGrantSnapshot {
    return { ...this.snapshot, revoked: this.revoked };
  }

  isActive(): boolean {
    return !this.revoked && this.now() < this.snapshot.expiresAt;
  }

  revoke(): void {
    this.revoked = true;
  }

  /** Final grant check, after shared schemas and safety policies resolve a command. */
  async allowsCommand(
    input: DeviceExecutionGateInput,
    getCurrentIntensity: () => number | Promise<number>,
    limits: { intensityCap: number; maxBurstDurationMs: number },
  ): Promise<boolean> {
    if (!this.isActive() || input.deviceKind !== this.snapshot.targetKind) return false;

    const command = input.command;
    if (command.type === 'setIndicatorColor') return false;

    // Stops remain broader than the selected channel by design. Reducing all
    // output on the authorized target is safe and keeps the escape path simple.
    if (
      command.type === 'stop' ||
      command.type === 'emergencyStop' ||
      command.type === 'vibrateStop'
    ) {
      return true;
    }

    if (!('channel' in command) || command.channel !== this.snapshot.channel) return false;

    const cap = Math.min(
      this.snapshot.intensityCap,
      clampInteger(limits.intensityCap, 0, VIDEO_CONTROL_MAX_INTENSITY),
    );

    switch (command.type) {
      case 'start': {
        if (command.strength > cap) return false;
        const current = await getCurrentIntensity();
        return this.snapshot.allowEnhanced || current <= 0 || command.strength <= current;
      }
      case 'vibrateStart': {
        if (command.intensity > cap) return false;
        const current = await getCurrentIntensity();
        return this.snapshot.allowEnhanced || current <= 0 || command.intensity <= current;
      }
      case 'adjustStrength':
      case 'vibrateAdjust': {
        if (command.delta > 0 && !this.snapshot.allowEnhanced) return false;
        return (await getCurrentIntensity()) + command.delta <= cap;
      }
      case 'burst':
        return (
          this.snapshot.allowBurst &&
          command.strength <= cap &&
          command.durationMs <= limits.maxBurstDurationMs
        );
      case 'vibrateBurst':
        return (
          this.snapshot.allowBurst &&
          command.intensity <= cap &&
          command.durationMs <= limits.maxBurstDurationMs
        );
      case 'changeWave':
      case 'vibrateSetPattern':
        return true;
      default:
        return false;
    }
  }
}

function requireTargetId(value: string): string {
  const targetId = value.trim();
  if (!targetId) throw new Error('Video 控制授权必须指定物理目标');
  return targetId;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? Math.round(value) : minimum;
  return Math.min(maximum, Math.max(minimum, normalized));
}
