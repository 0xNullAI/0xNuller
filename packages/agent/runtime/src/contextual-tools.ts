import type {
  ActionContext,
  SessionSnapshot,
  ToolCall,
  ToolDefinition,
  ToolExecutionPlan,
} from '@dg-agent/core';
export interface ContextualToolInput {
  session: SessionSnapshot;
  context: ActionContext;
}
/** Additional account/service tools receive the executing session directly, never a shared mutable current-session closure. */
export interface ContextualTools {
  permissionRequiredToolNames: ReadonlySet<string>;
  displayNames: Readonly<Record<string, string>>;
  listDefinitions(input: ContextualToolInput): Promise<ToolDefinition[]>;
  /** null delegates to the existing device/tool registry. */
  resolve(
    input: ContextualToolInput & { toolCall: ToolCall; abortSignal?: AbortSignal },
  ): Promise<ToolExecutionPlan | null>;
}
