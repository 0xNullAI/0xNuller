// 安全链契约。
//
// 合并前这组类型存在两份：@dg-agent/core 与 apps/voice/src/lib/types.ts（后者的
// 文件头自述是前者的「镜像切片」）。它们描述的是「调用方如何驱动安全链」，与 BLE
// 协议本身无关，所以落在这里而不是 @dg-kit/core。

import type { DeviceCommand } from '@dg-kit/core';

/** 指令来源。用于策略与权限决策，也用于把回复路由回原始渠道。 */
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
