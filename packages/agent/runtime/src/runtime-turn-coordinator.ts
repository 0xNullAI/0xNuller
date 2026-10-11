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
  SessionTraceStore,
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
  isStopTool,
  type TurnState,
  type TurnToolCallSummary,
} from './runtime-turn-state.js';
import { appendAssistantMessage, appendSkippedToolOutputs } from './session-history.js';
import { redactModelData } from './redact-model-data.js';
import type { ToolCallConfig } from './tool-call-config.js';
import type { ContextualTools } from './contextual-tools.js';
import type { ToolRegistry } from './tool-registry.js';
import { guardUnverifiedActionClaim } from './runtime-action-evidence.js';
import { createToolExecutionReceipt, type ToolExecutionReceipt } from './runtime-tool-receipt.js';

export interface RuntimeTurnResult {
  finalAssistantText: string;
  runId: string;
  status: 'completed' | 'incomplete' | 'needs-review';
  receipts: readonly ToolExecutionReceipt[];
}

function finishTurn(
  runId: string,
  finalAssistantText: string,
  receipts: readonly ToolExecutionReceipt[],
  exhausted = false,
  unverifiedClaim = false,
): RuntimeTurnResult {
  const status = receipts.some((receipt) => receipt.status === 'unknown')
    ? 'needs-review'
    : exhausted || unverifiedClaim || receipts.some((receipt) => receipt.status !== 'succeeded')
      ? 'incomplete'
      : 'completed';
  return { finalAssistantText, runId, status, receipts: [...receipts] };
}

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
  contextualTools?: ContextualTools;
  toolExecutor: Pick<RuntimeToolExecutor, 'execute' | 'getConnectedDeviceKinds'>;
  toolCallConfig: ToolCallConfig;
  modelContextStrategy?: ModelContextStrategy;
  buildInstructions?: (input: BuildTurnInstructionsInput) => string | Promise<string>;
  getInstructionDeviceState: () => Promise<TurnInstructionDeviceState>;
  saveSession: (session: SessionSnapshot) => Promise<void>;
  traceStore?: Pick<SessionTraceStore, 'append'>;
  emit: (event: RuntimeEvent) => void;
}

export interface RuntimeTurnHooks {
  /** Durable claim before dispatch. Non-stop tools fail closed if it throws. */
  beforeToolCall?: (input: { runId: string; callId: string; name: string }) => Promise<void>;
  onToolCallStarted?: (input: { runId: string; callId: string; name: string }) => void;
  /** A lost post-execution acknowledgement makes the outcome unconfirmed. */
  recordToolReceipt?: (receipt: ToolExecutionReceipt) => Promise<void>;
  onToolReceipt?: (receipt: ToolExecutionReceipt) => void;
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
    runId?: string;
    hooks?: RuntimeTurnHooks;
    allowTools?: boolean;
  }): Promise<RuntimeTurnResult> {
    const { session, turn, turnStartIndex, ephemeralInput, abortSignal, hooks } = input;
    const runId = input.runId ?? turn.context.traceId;
    const turnState = createTurnState();
    const toolEvidence: ToolExecutionReceipt[] = [];
    const seenCallIds = new Set<string>();

    for (
      let iteration = 0;
      iteration < this.options.toolCallConfig.maxToolIterations;
      iteration++
    ) {
      throwIfAborted(abortSignal);

      session.deviceState = await this.options.device.getState();
      const instructions = await this.buildInstructions(session, turn, turnState, iteration === 0);
      const toolingDisabled =
        input.allowTools === false || turn.context.sourceType === 'system' || !!turn.image;
      const tools = toolingDisabled
        ? []
        : filterToolDefinitionsByConnectedDevices(
            [
              ...(await this.options.toolRegistry.listDefinitions()),
              ...((await this.options.contextualTools?.listDefinitions({
                session,
                context: turn.context,
              })) ?? []),
            ],
            await this.options.toolExecutor.getConnectedDeviceKinds(session),
          );
      const conversation = buildConversationItems(
        session,
        turnState,
        iteration === 0 ? ephemeralInput : null,
        this.options.modelContextStrategy,
        instructions.length,
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
      let streamedThisIteration = false;
      const llmResult = await this.options.llm.runTurn({
        session,
        message: turn.text,
        context: turn.context,
        runId: input.runId,
        instructions,
        tools,
        conversation,
        image: iteration === 0 ? turn.image : undefined,
        abortSignal,
        onTextDelta: () => {
          // The provider can stream "I already did it" before returning its tool calls.
          // Hold prose until the executed results can be checked; voice playback consumes
          // this same event and must not speak an unverified claim either.
          streamedThisIteration = true;
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
        const finalAssistantText = guardUnverifiedActionClaim(
          llmResult.assistantMessage,
          toolEvidence,
        );
        if (streamedThisIteration)
          this.options.emit({
            type: 'assistant-message-delta',
            sessionId: session.id,
            content: finalAssistantText,
          });
        return finishTurn(
          runId,
          finalAssistantText,
          toolEvidence,
          false,
          finalAssistantText !== llmResult.assistantMessage,
        );
      }

      // Tool-call text arrives before any of those calls execute. Never persist a
      // premature completion claim as a session message or feed it back to the model.
      const checkedInterimMessage = guardUnverifiedActionClaim(
        llmResult.assistantMessage,
        toolEvidence,
      );
      const interimAssistantMessage =
        checkedInterimMessage === llmResult.assistantMessage ? checkedInterimMessage : '';
      const iterationItems: LlmConversationItem[] = [];
      const hasTextOrReasoning =
        interimAssistantMessage.trim().length > 0 ||
        (llmResult.reasoningContent?.trim().length ?? 0) > 0;
      if (hasTextOrReasoning || (llmResult.toolCalls?.length ?? 0) > 0) {
        if (hasTextOrReasoning) {
          appendAssistantMessage(
            session,
            {
              content: interimAssistantMessage,
              reasoningContent: llmResult.reasoningContent,
              toolCalls: llmResult.toolCalls,
            },
            turnStartIndex,
          );
        }
        iterationItems.push({
          kind: 'message',
          role: 'assistant',
          content: interimAssistantMessage,
          reasoningContent: llmResult.reasoningContent,
          toolCalls: llmResult.toolCalls,
        });
        session.updatedAt = Date.now();
        await this.options.saveSession(session);
        this.options.emit({ type: 'session-updated', sessionId: session.id });
      }

      const toolCalls = llmResult.toolCalls ?? [];
      let interruptedOutcome: {
        name: string;
        status: 'unknown' | 'pending' | 'denied' | 'failed';
        disconnected?: ReturnType<typeof resolveRequiredDeviceKind>;
      } | null = null;
      for (let index = 0; index < toolCalls.length; index += 1) {
        let toolCall = toolCalls[index];
        if (!toolCall) continue;
        if (isStopTool(toolCall.name) && (!toolCall.id || seenCallIds.has(toolCall.id))) {
          // A stop must never be refused for a missing or reused provider call ID; that
          // would leave the device running. Run it under a fresh local ID instead.
          toolCall = { ...toolCall, id: `stop-${createStopCallId()}` };
        }
        if (interruptedOutcome && !isStopTool(toolCall.name)) {
          appendSkippedToolOutputs(
            iterationItems,
            [toolCall],
            'Skipped because an earlier tool outcome is unconfirmed or pending.',
          );
          continue;
        }
        const duplicateCallId = !toolCall.id || seenCallIds.has(toolCall.id);
        const prohibitedCall = toolingDisabled && !isStopTool(toolCall.name);
        let output: string;
        let unconfirmed = false;
        let dispatched = false;
        if (duplicateCallId) {
          output = deniedOutput('同一回合重复或缺失的工具调用编号，未再次执行');
        } else if (prohibitedCall) {
          seenCallIds.add(toolCall.id);
          output = deniedOutput('当前回合未开放工具调用，工具未执行');
          await this.recordToolTrace(
            session,
            turn,
            toolCall,
            'tool-denied',
            '当前回合未开放工具调用，工具未执行。',
          );
        } else {
          seenCallIds.add(toolCall.id);
          try {
            await hooks?.beforeToolCall?.({ runId, callId: toolCall.id, name: toolCall.name });
            dispatched = true;
          } catch {
            if (isStopTool(toolCall.name)) {
              // Stop remains reachable when the durable task service is down.
              dispatched = true;
              unconfirmed = true;
            }
          }
          if (dispatched) {
            hooks?.onToolCallStarted?.({ runId, callId: toolCall.id, name: toolCall.name });
            output = await this.options.toolExecutor.execute({
              session,
              toolCall,
              context: turn.context,
              turnState,
              abortSignal,
            });
          } else {
            output = deniedOutput('任务执行记录不可用，工具未执行');
            await this.recordToolTrace(session, turn, toolCall, 'tool-denied');
          }
        }
        if (!duplicateCallId) {
          let receipt = createToolExecutionReceipt({
            runId,
            callId: toolCall.id,
            name: toolCall.name,
            args: toolCall.args,
            output,
          });
          if (dispatched && !unconfirmed) {
            try {
              await hooks?.recordToolReceipt?.(receipt);
            } catch {
              unconfirmed = true;
            }
          }
          if (unconfirmed) {
            receipt = { ...receipt, status: 'unknown' };
            output = unknownOutput();
            await this.recordToolTrace(session, turn, toolCall, 'tool-unknown');
          }
          toolEvidence.push(receipt);
          hooks?.onToolReceipt?.(receipt);
          if (receipt.status === 'unknown' || receipt.status === 'pending') {
            // An unverified or asynchronous result cannot be used as a premise for
            // another model step. In particular, the raw owner response may say
            // `ok: true` even though it does not prove the requested side effect.
            // Give the user a deterministic status instead of asking the model to
            // summarize evidence it does not have.
            const pending = receipt.status === 'pending';
            if (!interruptedOutcome || receipt.status === 'unknown')
              interruptedOutcome = { name: toolCall.name, status: receipt.status };
            iterationItems.push({
              kind: 'function_call_output',
              callId: toolCall.id,
              output: pending ? pendingOutput() : unknownOutput(),
            });
            continue;
          }
          if (receipt.status === 'denied' || receipt.status === 'failed') {
            const disconnected = getDisconnectedDeviceKind(toolCall.name, toolCall.args, output);
            if (!interruptedOutcome)
              interruptedOutcome = {
                name: toolCall.name,
                status: receipt.status,
                ...(disconnected ? { disconnected } : {}),
              };
            iterationItems.push({ kind: 'function_call_output', callId: toolCall.id, output });
            continue;
          }
        }
        const interruption = getToolInterruption(output);
        if (interruption) {
          if (!interruptedOutcome)
            interruptedOutcome = { name: toolCall.name, status: interruption.status };
          iterationItems.push({ kind: 'function_call_output', callId: toolCall.id, output });
          continue;
        }

        const disconnectedDeviceKind = getDisconnectedDeviceKind(
          toolCall.name,
          toolCall.args,
          output,
        );
        if (disconnectedDeviceKind !== undefined) {
          if (!interruptedOutcome)
            interruptedOutcome = {
              name: toolCall.name,
              status: 'denied',
              disconnected: disconnectedDeviceKind,
            };
          iterationItems.push({ kind: 'function_call_output', callId: toolCall.id, output });
          continue;
        }

        iterationItems.push({ kind: 'function_call_output', callId: toolCall.id, output });
      }

      turnState.workingItems.push(...iterationItems);
      if (interruptedOutcome) {
        const finalAssistantText =
          interruptedOutcome.disconnected !== undefined
            ? buildDeviceDisconnectedMessage(interruptedOutcome.disconnected)
            : interruptedOutcome.status === 'pending'
              ? `工具“${interruptedOutcome.name}”仍在处理中，尚不能确认完成。本批后续非停止操作未执行；如有停止操作，请核对其结果。`
              : interruptedOutcome.status === 'unknown' && isStopTool(interruptedOutcome.name)
                ? '不能确认“停止设备”已完成。请核对实际设备状态；本批后续非停止操作未执行。'
                : interruptedOutcome.status === 'unknown'
                  ? `工具“${interruptedOutcome.name}”的执行状态未确认。请核对实际结果后再决定是否重试；本批后续非停止操作未执行。`
                  : `工具“${interruptedOutcome.name}”${interruptedOutcome.status === 'failed' ? '执行失败' : '被拒绝'}，未完成请求的操作。本批后续非停止操作未执行。`;
        this.options.emit({
          type: 'assistant-message-delta',
          sessionId: session.id,
          content: finalAssistantText,
        });
        return finishTurn(runId, finalAssistantText, toolEvidence, false, true);
      }
    }

    return this.runNoToolFollowUp(
      session,
      turn,
      turnState,
      '本回合工具步数已达上限。只能根据已有工具结果说明已完成与未完成步骤，不要再请求工具。',
      toolEvidence,
      abortSignal,
      true,
      runId,
      input.runId,
    );
  }

  private async runNoToolFollowUp(
    session: SessionSnapshot,
    turn: RuntimeTurnInput,
    turnState: TurnState,
    triggerText: string,
    toolEvidence: readonly ToolExecutionReceipt[],
    abortSignal?: AbortSignal,
    exhausted = false,
    runId = turn.context.traceId,
    billingRunId?: string,
  ): Promise<RuntimeTurnResult> {
    let streamed = false;
    const instructions = await this.buildInstructions(session, turn, turnState, false);
    const llmResult = await this.options.llm.runTurn({
      session,
      message: triggerText,
      context: turn.context,
      runId: billingRunId,
      instructions,
      tools: [],
      conversation: buildConversationItems(
        session,
        turnState,
        { kind: 'message', role: 'user', content: triggerText },
        this.options.modelContextStrategy,
        instructions.length,
      ),
      abortSignal,
      onTextDelta: () => {
        streamed = true;
      },
    });

    throwIfAborted(abortSignal);
    const finalAssistantText = llmResult.toolCalls?.length
      ? TOOL_LOOP_EXHAUSTED_MESSAGE
      : guardUnverifiedActionClaim(llmResult.assistantMessage, toolEvidence);
    if (streamed)
      this.options.emit({
        type: 'assistant-message-delta',
        sessionId: session.id,
        content: finalAssistantText,
      });
    return finishTurn(
      runId,
      finalAssistantText,
      toolEvidence,
      exhausted || !!llmResult.toolCalls?.length,
      finalAssistantText !== llmResult.assistantMessage,
    );
  }

  private async recordToolTrace(
    session: SessionSnapshot,
    turn: RuntimeTurnInput,
    toolCall: { id: string; name: string; args: Record<string, unknown> },
    kind: 'tool-denied' | 'tool-unknown',
    reason?: string,
  ): Promise<void> {
    const detail =
      reason ??
      (kind === 'tool-denied'
        ? '任务执行记录不可用，工具未执行。'
        : '工具结果未能写入任务记录，请核对实际结果后再决定是否重试。');
    try {
      await this.options.traceStore?.append(session.id, {
        kind,
        turnId: turn.context.traceId,
        sourceType: turn.context.sourceType,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.args,
        detail,
      });
    } catch {
      // The receipt still fails closed when the trace store is unavailable.
    }
    this.options.emit({ type: 'runtime-warning', sessionId: session.id, message: detail });
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

function deniedOutput(error: string): string {
  return JSON.stringify({ error, _meta: { kind: 'tool-denied' } });
}

function unknownOutput(): string {
  return JSON.stringify({
    error: '工具执行状态未确认，请核对实际结果后再决定是否重试。',
    _meta: { kind: 'tool-unknown' },
  });
}

function pendingOutput(): string {
  return JSON.stringify({
    status: 'pending',
    _meta: { kind: 'tool-pending' },
  });
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

function getToolInterruption(output: string): { status: 'unknown' | 'failed' | 'denied' } | null {
  try {
    const parsed = JSON.parse(output) as { error?: string; _meta?: { kind?: string } };
    const kind = parsed._meta?.kind;
    if (!['tool-denied', 'tool-failed', 'tool-unknown'].includes(kind ?? '') || !parsed.error)
      return null;
    if (parsed.error === '设备未连接') return null;
    return {
      status: kind === 'tool-unknown' ? 'unknown' : kind === 'tool-failed' ? 'failed' : 'denied',
    };
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

function createStopCallId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
