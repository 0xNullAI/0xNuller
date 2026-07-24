/**
 * Agent-only contracts DG-Voice needs but `@dg-kit/*` doesn't ship (they're
 * specific to how a caller drives the safety chain, not to the BLE protocol
 * itself). Mirrors the equivalent slice of `@dg-agent/core` — DG-Voice has
 * no bridge/session/LLM-conversation surface, so this is deliberately much
 * smaller than that package.
 */
import type { DeviceCommand, OpossumCommand } from '@dg-kit/core';

export interface ActionContext {
  sessionId: string;
}

export type PolicyDecision =
  | { type: 'allow' }
  | { type: 'deny'; reason: string }
  | { type: 'clamp'; command: DeviceCommand; reason: string }
  | { type: 'require-confirm'; reason: string };

export type OpossumPolicyDecision =
  | { type: 'allow' }
  | { type: 'deny'; reason: string }
  | { type: 'clamp'; command: OpossumCommand; reason: string }
  | { type: 'require-confirm'; reason: string };

export type PermissionDecision =
  | { type: 'approve-once' }
  | { type: 'approve-scoped'; expiresAt?: number }
  | { type: 'deny'; reason?: string };

export interface PermissionRequest {
  context: ActionContext;
  toolName: string;
  toolDisplayName?: string;
  summary: string;
  args: Record<string, unknown>;
}

export interface PermissionService {
  request(input: PermissionRequest): Promise<PermissionDecision>;
}
