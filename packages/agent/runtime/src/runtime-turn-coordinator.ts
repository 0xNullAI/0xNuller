import type {
  ActionContext,
  CoyoteTargetSnapshot,
  DeviceClient,
  LlmClient,
  LlmConversationItem,
  LlmImageInput,
  ModelContextStrategy,
  RuntimeEvent,
  SensorState,
  SessionSnapshot,
} from '@dg-agent/core';
import { isDeviceToolName } from '@dg-agent/core';
import type { OpossumState } from '@dg-kit/protocol';
import { throwIfAborted, TOOL_LOOP_EXHAUSTED_MESSAGE } from './runtime-errors.js';
import {
  DEVICE_KIND_DISPLAY_NAME,
  filterToolDefinitionsByConnectedDevices,
  resolveRequiredDeviceKind,
  type RuntimeToolExecutor,
} from './runtime-tool-executor.js';
import {
  buildConversationItems,
  collectTurnToolCalls,
  createTurnState,
  type TurnState,
  type TurnToolCallSummary,
} from './runtime-turn-state.js';
import { appendAssistantMessage, appendSkippedToolOutputs } from './session-history.js';
import { redactModelData } from './redact-model-data.js';
import type { ToolCallConfig } from './tool-call-config.js';
import type { ToolRegistry } from './tool-registry.js';

export interface TurnInstructionDeviceState {
  /** Every currently connected Coyote instance, preserving opaque identities. */
  coyoteTargets?: CoyoteTargetSnapshot[];
  /** Present only when an Opossum client is configured, connected or not. */
  opossumState?: OpossumState;
  /** Present only when a paw-prints client is configured, connected or not. */
  pawPrintsState?: SensorState;
  /** Present only when a civet-edging client is configured, connected or not. */
  civetEdgingState?: SensorState;
  /** Rolling 60s trigger-count summary; absent until the buffer has a reading. */
  pawPrintsSummary?: string;
  /** Rolling 30s pressure trend summary; absent until the buffer has a reading. */
  civetSummary?: string;
}

export interface BuildTurnInstructionsInput extends TurnInstructionDeviceState {
  session: SessionSnapshot;
  context: ActionContext;
  isFirstIteration: boolean;
  turnToolCalls: readonly TurnToolCallSummary[];
}

export interface RuntimeTurnInput {
  text: string;
  context: ActionContext;
  image?: LlmImageInput;
}

export interface RuntimeTurnCoordinatorOptions {
  device: Pick<DeviceClient, 'getState'>;
  llm: LlmClient;
  toolRegistry: ToolRegistry;
  toolExecutor: Pick<RuntimeToolExecutor, 'execute' | 'getConnectedDeviceKinds'>;
  toolCallConfig: ToolCallConfig;
  modelContextStrategy?: ModelContextStrategy;
  buildInstructions?: (input: BuildTurnInstructionsInput) => string;
  getInstructionDeviceState: () => Promise<TurnInstructionDeviceState>;
  saveSession: (session: SessionSnapshot) => Promise<void>;
  emit: (event: RuntimeEvent) => void;
}

/** Coordinates one model reply and its bounded tool-call iterations. */
export class RuntimeTurnCoordinator {
  constructor(private readonly options: RuntimeTurnCoordinatorOptions) {}

  async run(input: {
    session: SessionSnapshot;
    turn: RuntimeTurnInput;
    turnStartIndex: number;
    ephemeralInput: LlmConversationItem | null;
    abortSignal?: AbortSignal;
  }): Promise<{ finalAssistantText: string }> {
    const { session, turn, turnStartIndex, ephemeralInput, abortSignal } = input;
    const turnState = createTurnState();

    for (
      let iteration = 0;
      iteration < this.options.toolCallConfig.maxToolIterations;
      iteration++
    ) {
      throwIfAborted(abortSignal);

      session.deviceState = await this.options.device.getState();
      const instructions = await this.buildInstructions(session, turn, turnState, iteration === 0);
      const tools =
        turn.context.sourceType === 'system' || turn.image
          ? []
          : filterToolDefinitionsByConnectedDevices(
              await this.options.toolRegistry.listDefinitions(),
              await this.options.toolExecutor.getConnectedDeviceKinds(session),
            );
      const conversation = buildConversationItems(
        session,
        turnState,
        iteration === 0 ? ephemeralInput : null,
        this.options.modelContextStrategy,
      );

      this.options.emit({
        type: 'llm-turn-start',
        sessionId: session.id,
        iteration,
        instructions,
        messages: summarizeConversation(conversation),
        toolNames: tools.map((tool) => tool.name),
      });

      let capturedRequest: unknown;
      const llmResult = await this.options.llm.runTurn({
        session,
        message: turn.text,
        context: turn.context,
        instructions,
        tools,
        conversation,
        image: iteration === 0 ? turn.image : undefined,
        abortSignal,
        onTextDelta: (content) => {
          this.options.emit({
            type: 'assistant-message-delta',
            sessionId: session.id,
            content,
          });
        },
        onRawRequest: (body) => {
          capturedRequest = body;
        },
      });

      this.options.emit({
        type: 'llm-turn-complete',
        sessionId: session.id,
        iteration,
        assistantMessage: llmResult.assistantMessage,
        toolCalls: llmResult.toolCalls ?? [],
        rawRequest: redactModelData(capturedRequest),
        rawResponse: redactModelData(llmResult.rawResponse),
      });

      // This checkpoint prevents a late provider result from starting tools
      // after the outer runtime has aborted or emergency-stopped the turn.
      throwIfAborted(abortSignal);

      if ((llmResult.toolCalls ?? []).length === 0) {
        return { finalAssistantText: llmResult.assistantMessage };
      }

      const iterationItems: LlmConversationItem[] = [];
      const hasTextOrReasoning =
        llmResult.assistantMessage.trim().length > 0 ||
        (llmResult.reasoningContent?.trim().length ?? 0) > 0;
      if (hasTextOrReasoning || (llmResult.toolCalls?.length ?? 0) > 0) {
        if (hasTextOrReasoning) {
          appendAssistantMessage(
            session,
            {
              content: llmResult.assistantMessage,
              reasoningContent: llmResult.reasoningContent,
              toolCalls: llmResult.toolCalls,
            },
            turnStartIndex,
          );
        }
        iterationItems.push({
          kind: 'message',
          role: 'assistant',
          content: llmResult.assistantMessage,
          reasoningContent: llmResult.reasoningContent,
          toolCalls: llmResult.toolCalls,
        });
        session.updatedAt = Date.now();
        await this.options.saveSession(session);
        this.options.emit({ type: 'session-updated', sessionId: session.id });
      }

      const toolCalls = llmResult.toolCalls ?? [];
      for (let index = 0; index < toolCalls.length; index += 1) {
        const toolCall = toolCalls[index];
        if (!toolCall) continue;
        const output = await this.options.toolExecutor.execute({
          session,
          toolCall,
          context: turn.context,
          turnState,
          abortSignal,
        });
        const deniedTrigger = getEphemeralDeniedTrigger(toolCall, output);
        if (deniedTrigger) {
          appendToolOutputAndSkippedCalls(
            iterationItems,
            toolCall.id,
            output,
            toolCalls.slice(index + 1),
            'Skipped after an earlier tool call was denied.',
          );
          turnState.workingItems.push(...iterationItems);
          return this.runNoToolFollowUp(session, turn, turnState, deniedTrigger, abortSignal);
        }

        const disconnectedDeviceKind = getDisconnectedDeviceKind(
          toolCall.name,
          toolCall.args,
          output,
        );
        if (disconnectedDeviceKind !== undefined) {
          appendToolOutputAndSkippedCalls(
            iterationItems,
            toolCall.id,
            output,
            toolCalls.slice(index + 1),
            'Skipped because the device is not connected.',
          );
          turnState.workingItems.push(...iterationItems);
          return {
            finalAssistantText: buildDeviceDisconnectedMessage(disconnectedDeviceKind),
          };
        }

        iterationItems.push({ kind: 'function_call_output', callId: toolCall.id, output });
      }

      turnState.workingItems.push(...iterationItems);
    }

    return { finalAssistantText: TOOL_LOOP_EXHAUSTED_MESSAGE };
  }

  private async runNoToolFollowUp(
    session: SessionSnapshot,
    turn: RuntimeTurnInput,
    turnState: TurnState,
    triggerText: string,
    abortSignal?: AbortSignal,
  ): Promise<{ finalAssistantText: string }> {
    const llmResult = await this.options.llm.runTurn({
      session,
      message: triggerText,
      context: turn.context,
      instructions: await this.buildInstructions(session, turn, turnState, false),
      tools: [],
      conversation: buildConversationItems(
        session,
        turnState,
        { kind: 'message', role: 'user', content: triggerText },
        this.options.modelContextStrategy,
      ),
      abortSignal,
      onTextDelta: (content) => {
        this.options.emit({
          type: 'assistant-message-delta',
          sessionId: session.id,
          content,
        });
      },
    });

    return { finalAssistantText: llmResult.assistantMessage };
  }

  private async buildInstructions(
    session: SessionSnapshot,
    turn: RuntimeTurnInput,
    turnState: TurnState,
    isFirstIteration: boolean,
  ): Promise<string> {
    if (!this.options.buildInstructions) return '';
    return this.options.buildInstructions({
      session,
      context: turn.context,
      isFirstIteration,
      turnToolCalls: collectTurnToolCalls(turnState),
      ...(await this.options.getInstructionDeviceState()),
    });
  }
}

function summarizeConversation(conversation: LlmConversationItem[]) {
  return conversation.map((item) => ({
    role:
      item.kind === 'message'
        ? item.role
        : item.kind === 'function_call'
          ? 'tool_call'
          : 'tool_result',
    content:
      item.kind === 'message'
        ? item.content
        : item.kind === 'function_call'
          ? `${item.name}(${item.argumentsJson})`
          : item.output,
    toolCallCount:
      item.kind === 'message' && item.toolCalls?.length ? item.toolCalls.length : undefined,
  }));
}

function appendToolOutputAndSkippedCalls(
  items: LlmConversationItem[],
  callId: string,
  output: string,
  skippedCalls: Parameters<typeof appendSkippedToolOutputs>[1],
  reason: string,
): void {
  items.push({ kind: 'function_call_output', callId, output });
  appendSkippedToolOutputs(items, skippedCalls, reason);
}

function getEphemeralDeniedTrigger(toolCall: { name: string }, output: string): string | null {
  try {
    const parsed = JSON.parse(output) as { error?: string; _meta?: { kind?: string } };
    const kind = parsed._meta?.kind;
    if ((kind !== 'tool-denied' && kind !== 'tool-failed') || !parsed.error) return null;
    if (parsed.error === '设备未连接') return null;

    return [
      `[内部提醒] 刚才请求的工具“${toolCall.name}”未执行。`,
      `原因：${parsed.error}`,
      kind === 'tool-failed'
        ? '请直接向用户解释执行失败的原因，不要再次调用工具，也不要假装已经成功。'
        : '请直接向用户解释这一步没有执行，不要再次调用工具，也不要假装已经成功。',
    ].join('\n');
  } catch {
    return null;
  }
}

function getDisconnectedDeviceKind(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
) {
  if (!isDeviceToolName(toolName)) return undefined;

  try {
    const parsed = JSON.parse(output) as { error?: string };
    if (parsed.error !== '设备未连接') return undefined;
  } catch {
    return undefined;
  }

  return resolveRequiredDeviceKind(toolName, args);
}

function buildDeviceDisconnectedMessage(
  kind: ReturnType<typeof resolveRequiredDeviceKind>,
): string {
  const name = kind ? DEVICE_KIND_DISPLAY_NAME[kind] : '设备';
  return `设备未连接，请先点击输入框旁的蓝牙图标连接${name}。`;
}
