// Safety-chain contracts.
//
// Before the merge these types existed twice: in @dg-agent/core and in
// apps/voice/src/lib/types.ts (whose file header described itself as a
// "mirror slice" of the former). They describe how a caller drives the
// safety chain, not the BLE protocol itself — hence this package rather
// than @dg-kit/core.

import type { DeviceCommand } from '@dg-kit/core';

/** Command origin. Used for policy/permission decisions and for routing replies back to the original channel. */
export type SourceType = 'web' | 'qq' | 'telegram' | 'cli' | 'api' | 'system' | 'sensor';

export interface ActionContext {
  sessionId: string;
  sourceType: SourceType;
  sourceUserId?: string;
  sourceUserName?: string;
  sourceChannelId?: string;
  traceId: string;
}

export type PermissionDecision =
  | { type: 'approve-once' }
  | { type: 'approve-scoped'; expiresAt?: number }
  | { type: 'deny'; reason?: string };

export type PolicyDecision =
  | { type: 'allow' }
  | { type: 'deny'; reason: string }
  | { type: 'clamp'; command: DeviceCommand; reason: string }
  | { type: 'require-confirm'; reason: string };

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
