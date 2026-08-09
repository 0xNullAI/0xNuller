// @dg-kit/safety — the single source of truth for the device safety chain.
//
// Policy engine (strength caps / cold-start clamp / burst-specific caps /
// cumulative ceiling), default policies, and the serial command queue (with
// emergency-stop preemption and generation invalidation). Before the merge
// DG-Agent and DG-Voice each held a copy; stripped of imports and comments
// the two were byte-identical, so merging involved no behavioral judgment
// calls.
export * from './contracts.js';
export * from './policy-engine.js';
export * from './default-policies.js';
export * from './device-command-queue.js';
export * from './safety-bus.js';
export * from './safety-notice-content.js';
export * from './safety-acceptance.js';
