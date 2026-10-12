import type { DeviceLeaseSnapshot } from '@dg-kit/safety';

/**
 * The lease a command was admitted under.
 *
 * A holder name alone cannot tell `agent → chat → agent` from one uninterrupted `agent` lease, so
 * the fence carries the bus epoch too. Both fields are compared again immediately before the
 * native write; any change rejects the command.
 */
export interface LeaseFence {
  holder: string;
  epoch: number;
}

export type LeaseFenceRejection = 'lease-not-held' | 'lease-changed';

export type LeaseAdmission =
  { ok: true; fence: LeaseFence } | { ok: false; reason: LeaseFenceRejection };

export type LeaseFenceCheck = { ok: true } | { ok: false; reason: LeaseFenceRejection };

/** Capture the fence at admission. Only the current holder may start or raise output. */
export function admitUnderLease(moduleId: string, snapshot: DeviceLeaseSnapshot): LeaseAdmission {
  if (snapshot.holder === null || snapshot.holder !== moduleId) {
    return { ok: false, reason: 'lease-not-held' };
  }
  return { ok: true, fence: { holder: snapshot.holder, epoch: snapshot.epoch } };
}

/** Re-check a captured fence against the lease as it is right now. */
export function checkLeaseFence(fence: LeaseFence, snapshot: DeviceLeaseSnapshot): LeaseFenceCheck {
  if (snapshot.epoch !== fence.epoch) return { ok: false, reason: 'lease-changed' };
  if (snapshot.holder !== fence.holder) return { ok: false, reason: 'lease-not-held' };
  return { ok: true };
}
