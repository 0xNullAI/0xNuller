import type {
  CoyoteTargetRouter,
  DeviceClient,
  LlmConversationItem,
  LlmClient,
  LlmImageInput,
  Logger,
  PermissionService,
  SensorState,
  SessionStore,
  SessionTraceStore,
  SourceType,
  WaveformLibrary,
} from '@dg-agent/core';
import type { ContextualTools } from './contextual-tools.js';
import { bindSessionCharacter } from './session-character.js';
import type { OpossumState } from '@dg-kit/protocol';
import {
  createEmptyDeviceState,
  createMessage,
  isSensorTriggersEnabled,
  mergeBridgeOriginMetadata,
  SESSION_TITLE_METADATA_KEY,
  withSensorLastReading,
  withSensorTriggersEnabled,
  type ActionContext,
  type ConversationMessage,
  type ModelContextStrategy,
  type RuntimeTraceEntry,
  type SessionSnapshot,
  type DeviceLinkRule,
} from '@dg-agent/core';
import { createDefaultOpossumPolicyRules, createDefaultPolicyRules } from '@dg-kit/safety';
import type { CivetEdgingClient, OpossumClient, PawPrintsClient } from './device-clients.js';
import { DeviceCommandQueue, OpossumCommandQueue } from '@dg-kit/safety';
import { InMemoryEventBus, type RuntimeListener } from './event-bus.js';
import { InMemorySessionStore } from './in-memory-session-store.js';
import { OpossumPolicyEngine, PolicyEngine } from '@dg-kit/safety';
import {
  isAbortError,
  normalizeAssistantErrorMessage,
  REPLY_ABORTED_ERROR_MESSAGE,
  REPLY_ABORTED_NOTE,
  throwIfAborted,
} from './runtime-errors.js';
import {
  RuntimeToolExecutor,
  type DeviceExecutionGate,
  type TimerFiredTrigger,
} from './runtime-tool-executor.js';
import {
  createCivetPressureBuffer,
  createPawPrintsTriggerBuffer,
  summarizeCivetPressure,
  summarizePawPrintsTriggers,
  type SensorReadingBuffer,
} from './sensor-reading-buffer.js';
import {
  SensorTriggerEngine,
  type SensorFiredTrigger,
  type SensorTriggerEngineOptions,
} from './sensor-trigger-engine.js';
import {
  resolveToolCallConfig,
  type ToolCallConfig,
  type ToolCallConfigInput,
} from './tool-call-config.js';
import { InMemorySessionTraceStore } from './session-trace.js';
import { DeviceLinkEngine } from './device-link-engine.js';
import { normalizeSessionHistory, appendAssistantMessage } from './session-history.js';
import { createDefaultToolRegistryWithDeps } from './tool-registry.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  RuntimeTurnCoordinator,
  type BuildTurnInstructionsInput,
} from './runtime-turn-coordinator.js';
import {
  RuntimeTaskRunLedger,
  type RuntimeTaskRunReporter,
  type RuntimeTaskRunSnapshot,
  type RuntimeTaskRunStatus,
} from './runtime-task-run.js';

export interface AgentRuntimeOptions {
  device: DeviceClient;
  /** Exact Coyote target enumeration and execution boundary. */
  coyoteTargetRouter?: CoyoteTargetRouter;
  /** At most one connected Opossum vibration controller, alongside Coyote. */
  opossum?: OpossumClient;
  /** At most one connected paw-prints button/motion sensor, alongside Coyote. */
  pawPrints?: PawPrintsClient;
  /** At most one connected civet-edging pressure sensor, alongside Coyote. */
  civetEdging?: CivetEdgingClient;
  llm: LlmClient;
  permission: PermissionService;
  buildInstructions?: (input: BuildTurnInstructionsInput) => string | Promise<string>;
  waveformLibrary?: WaveformLibrary;
  sessionStore?: SessionStore;
  sessionTraceStore?: SessionTraceStore;
  taskRunReporter?: RuntimeTaskRunReporter;
  onTaskRunUpdate?: (snapshot: RuntimeTaskRunSnapshot) => void;
  logger?: Logger;
  toolRegistry?: ToolRegistry;
  contextualTools?: ContextualTools;
  policyEngine?: PolicyEngine;
  opossumPolicyEngine?: OpossumPolicyEngine;
  toolCallConfig?: ToolCallConfigInput;
  modelContextStrategy?: ModelContextStrategy;
  /** Thresholds for the Sensor Trigger Engine (see `setSensorTriggersEnabled`). */
  sensorTriggerOptions?: Pick<
    SensorTriggerEngineOptions,
    'civetPressureDeltaThresholdKPa' | 'debounceMs' | 'now'
  >;
  /** Optional, explicit sensor/button → Opossum direct-control rule. */
  deviceLinkRule?: DeviceLinkRule;
  /** Final device-boundary gate, intended for module-lease validation. Defaults to allow. */
  deviceExecutionGate?: DeviceExecutionGate;
  /** Extra state-changing registry tools routed through the existing permission service. */
  permissionRequiredToolNames?: ReadonlySet<string>;
}

export interface SendUserMessageInput {
  sessionId: string;
  /** Server-issued ID when taskRunReporter is configured; never reuse for a new request. */
  runId?: string;
  /** Optional first-turn identity for a personal web conversation; cannot replace an existing binding. */
  characterId?: string;
  relationshipId?: string;
  text: string;
  context: ActionContext;
  persistMessage?: boolean;
  /** One ephemeral visual frame. This field is never copied into SessionSnapshot. */
  image?: LlmImageInput;
}

export type { TurnToolCallSummary } from './runtime-turn-state.js';

const defaultLogger: Logger = {
  info(message, meta) {
    console.log(message, meta ?? {});
  },
  warn(message, meta) {
    console.warn(message, meta ?? {});
  },
  error(message, meta) {
    console.error(message, meta ?? {});
  },
};

export class AgentRuntime {
  readonly capabilities;
  private readonly events = new InMemoryEventBus();
  private readonly sessions: SessionStore;
  private readonly traces: SessionTraceStore;
  private readonly queue: DeviceCommandQueue;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolCallConfig: ToolCallConfig;
  private readonly toolExecutor: RuntimeToolExecutor;
  private readonly turnCoordinator: RuntimeTurnCoordinator;
  private readonly taskRuns = new RuntimeTaskRunLedger();
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly pendingSystemWork = new Map<string, QueuedSystemWork[]>();
  private readonly drainingSessions = new Set<string>();
  private readonly deletedSessionIds = new Set<string>();
  private readonly sessionTitleOverrides = new Map<string, string | null>();
  private readonly disposeDeviceListener: () => void;
  private readonly opossumQueue?: OpossumCommandQueue;
  private sensorTriggerEngine: SensorTriggerEngine | null = null;
  private deviceLinkEngine: DeviceLinkEngine | null = null;
  private sensorTriggerSessionId: string | null = null;
  private readonly pawPrintsBuffer?: SensorReadingBuffer<{ eventId: number }>;
  private readonly civetBuffer?: SensorReadingBuffer<number>;
  private readonly disposeSensorBufferListeners: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.capabilities = { imageInput: options.llm.capabilities?.imageInput === true };
    this.sessions = options.sessionStore ?? new InMemorySessionStore();
    this.traces = options.sessionTraceStore ?? new InMemorySessionTraceStore();
    this.queue = new DeviceCommandQueue(options.device);
    this.opossumQueue = options.opossum ? new OpossumCommandQueue(options.opossum) : undefined;
    if (options.deviceLinkRule) {
      this.deviceLinkEngine = new DeviceLinkEngine({
        rule: options.deviceLinkRule,
        opossum: options.opossum,
        pawPrints: options.pawPrints,
        civetEdging: options.civetEdging,
        canExecute: () => this.canExecuteDeviceLink(),
      });
    }
    this.toolRegistry =
      options.toolRegistry ??
      createDefaultToolRegistryWithDeps({ waveformLibrary: options.waveformLibrary });
    this.toolCallConfig = resolveToolCallConfig(options.toolCallConfig);

    const policyEngine = options.policyEngine ?? new PolicyEngine(createDefaultPolicyRules());
    const opossumPolicyEngine =
      options.opossumPolicyEngine ?? new OpossumPolicyEngine(createDefaultOpossumPolicyRules());
    const logger = options.logger ?? defaultLogger;
    this.toolExecutor = new RuntimeToolExecutor({
      device: options.device,
      coyoteTargetRouter: options.coyoteTargetRouter,
      opossum: options.opossum,
      pawPrints: options.pawPrints,
      civetEdging: options.civetEdging,
      permission: options.permission,
      queue: this.queue,
      opossumQueue: this.opossumQueue,
      toolRegistry: this.toolRegistry,
      contextualTools: options.contextualTools,
      policyEngine,
      opossumPolicyEngine,
      logger,
      toolCallConfig: this.toolCallConfig,
      emit: (event) => {
        this.events.emit(event);
      },
      enqueueTimerTrigger: (trigger) =>
        this.enqueueSystemWork(trigger.sessionId, {
          kind: 'timer-fired',
          trigger,
          generation: trigger.generation,
        }),
      getSessionGeneration: (sessionId) => this.getSessionGeneration(sessionId),
      traceStore: this.traces,
      deviceExecutionGate: options.deviceExecutionGate ?? (() => true),
      permissionRequiredToolNames: options.permissionRequiredToolNames,
    });
    this.turnCoordinator = new RuntimeTurnCoordinator({
      device: options.device,
      llm: options.llm,
      toolRegistry: this.toolRegistry,
      contextualTools: options.contextualTools,
      toolExecutor: this.toolExecutor,
      toolCallConfig: this.toolCallConfig,
      traceStore: this.traces,
      modelContextStrategy: options.modelContextStrategy,
      buildInstructions: options.buildInstructions,
      getInstructionDeviceState: () => this.getAuxDeviceStatesForInstructions(),
      saveSession: (session) => this.saveSessionIfAvailable(session),
      emit: (event) => this.events.emit(event),
    });

    this.disposeDeviceListener = options.device.onStateChanged((state) => {
      if (this.disposed) return;
      this.events.emit({ type: 'device-state-changed', state });
    });

    // Buffers subscribe unconditionally, independent of the opt-in Sensor
    // Trigger Engine toggle — see sensor-reading-buffer.ts's doc comment for
    // why a passive summary line is lower-stakes than the trigger engine's
    // proactive prompts and doesn't need the same explicit consent gate.
    if (options.pawPrints) {
      this.pawPrintsBuffer = createPawPrintsTriggerBuffer();
      const pawPrints = options.pawPrints;
      const buffer = this.pawPrintsBuffer;
      this.disposeSensorBufferListeners.push(
        pawPrints.subscribe((reading) => {
          if (reading.type !== 'trigger') return;
          buffer.record({ eventId: reading.eventId });
        }),
      );
    }
    if (options.civetEdging) {
      this.civetBuffer = createCivetPressureBuffer();
      const buffer = this.civetBuffer;
      this.disposeSensorBufferListeners.push(
        options.civetEdging.subscribe((reading) => {
          buffer.record(reading.kPa);
        }),
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const sessionId of this.sessionGenerations.keys()) {
      this.bumpSessionGeneration(sessionId);
    }
    this.disposeDeviceListener();
    for (const unsubscribe of this.disposeSensorBufferListeners.splice(0)) {
      unsubscribe();
    }
    this.toolExecutor.cancelScheduledTimers();
    this.teardownSensorTriggerEngine();
    this.deviceLinkEngine?.dispose();
    this.deviceLinkEngine = null;
    for (const controller of this.activeTurns.values()) {
      controller.abort();
    }
    this.activeTurns.clear();
    this.pendingSystemWork.clear();
    // Keep the synchronous public API while still failing safe on teardown.
    void this.stopDevicesBestEffort();
  }

  /** Update the local sensor → Opossum bridge without rebuilding the runtime. */
  setDeviceLinkRule(rule: DeviceLinkRule): void {
    if (!this.deviceLinkEngine) {
      this.deviceLinkEngine = new DeviceLinkEngine({
        rule,
        opossum: this.options.opossum,
        pawPrints: this.options.pawPrints,
        civetEdging: this.options.civetEdging,
        canExecute: () => this.canExecuteDeviceLink(),
      });
    } else {
      this.deviceLinkEngine.setRule(rule);
    }
  }

  getDeviceLinkRule(): DeviceLinkRule | null {
    return this.deviceLinkEngine?.getRule() ?? null;
  }

  /**
   * Opt-in gate for the Sensor Trigger Engine (see sensor-trigger-engine.ts).
   * Defaults to off — connecting a paw-prints/civet-edging sensor is never
   * enough on its own to start feeding ephemeral prompts into a session; the
   * user has to explicitly flip this on per session first, mirroring the
   * "explicit consent, default off" pattern used elsewhere in this app
   * (e.g. permissions-browser's timed grants).
   *
   * At most one engine is active at a time, scoped to a single session (the
   * device connections themselves are process-global, same as Coyote's
   * `device`, but "let sensor events interrupt the AI" is a per-conversation
   * decision). Enabling it for a different session tears down the previous
   * one first.
   */
  async setSensorTriggersEnabled(sessionId: string, enabled: boolean): Promise<void> {
    // Stopping an opt-in must not wait on the server-backed history store.
    if (!enabled) this.teardownSensorTriggerEngine();
    const session = await this.ensureSession(sessionId);
    session.metadata = withSensorTriggersEnabled(session.metadata, enabled);
    session.updatedAt = Date.now();
    await this.saveSessionIfAvailable(session);

    if (this.sensorTriggerSessionId && this.sensorTriggerSessionId !== sessionId) {
      this.teardownSensorTriggerEngine();
    }

    if (!enabled) {
      this.teardownSensorTriggerEngine();
      return;
    }

    if (this.sensorTriggerEngine) return;

    if (!this.options.pawPrints && !this.options.civetEdging) {
      // Nothing connected to subscribe to right now. The flag is persisted
      // above so a future connect step (out of this task's scope — see
      // report) can attach the engine once a sensor is actually available.
      return;
    }

    this.sensorTriggerEngine = new SensorTriggerEngine({
      sessionId,
      pawPrints: this.options.pawPrints,
      civetEdging: this.options.civetEdging,
      ...this.options.sensorTriggerOptions,
      onTrigger: (trigger) =>
        this.enqueueSystemWork(trigger.sessionId, {
          kind: 'sensor-fired',
          trigger,
          generation: this.getSessionGeneration(trigger.sessionId),
        }),
    });
    this.sensorTriggerSessionId = sessionId;
  }

  async isSensorTriggersEnabledForSession(sessionId: string): Promise<boolean> {
    const session = await this.sessions.get(sessionId);
    return isSensorTriggersEnabled(session?.metadata);
  }

  private teardownSensorTriggerEngine(): void {
    this.sensorTriggerEngine?.dispose();
    this.sensorTriggerEngine = null;
    this.sensorTriggerSessionId = null;
  }

  subscribe(listener: RuntimeListener): () => void {
    return this.events.subscribe(listener);
  }

  async listSessions(): Promise<SessionSnapshot[]> {
    return this.sessions.listSummaries?.() ?? this.sessions.list();
  }

  async getSessionMessagesPage(sessionId: string, before?: number) {
    if (this.sessions.messagesPage) return this.sessions.messagesPage(sessionId, before);
    const session = await this.sessions.get(sessionId);
    if (!session) return { items: [], nextBefore: null };
    const end =
      before === undefined
        ? session.messages.length
        : Math.min(before - 1, session.messages.length);
    const start = Math.max(0, end - 20);
    return {
      items: session.messages.slice(start, end).map((message, index) => ({
        ...message,
        sequence: start + index + 1,
      })),
      nextBefore: start > 0 ? start + 1 : null,
    };
  }

  async searchSessions(query: string): Promise<string[]> {
    if (this.sessions.search) return this.sessions.search(query);
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return (await this.sessions.list())
      .filter(
        (session) =>
          (typeof session.metadata?.sessionTitle === 'string' &&
            session.metadata.sessionTitle.toLowerCase().includes(normalized)) ||
          session.messages.some((message) => message.content.toLowerCase().includes(normalized)),
      )
      .map((session) => session.id);
  }

  async getSessionTrace(sessionId: string): Promise<RuntimeTraceEntry[]> {
    if (this.isSessionDeleted(sessionId)) {
      return [];
    }
    const existing = await (this.sessions.getRecent?.(sessionId) ?? this.sessions.get(sessionId));
    if (!existing) {
      return [];
    }
    return this.traces.list(sessionId);
  }

  /** Local diagnostic view; server TaskRun events remain authoritative. */
  getTaskRun(runId: string): RuntimeTaskRunSnapshot | null {
    return this.taskRuns.get(runId);
  }

  listTaskRuns(sessionId: string): RuntimeTaskRunSnapshot[] {
    return this.taskRuns.list(sessionId);
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = await this.ensureSession(sessionId);
    const currentDeviceState = await this.options.device.getState();

    if (JSON.stringify(session.deviceState) !== JSON.stringify(currentDeviceState)) {
      const refreshedSession: SessionSnapshot = {
        ...session,
        deviceState: currentDeviceState,
        updatedAt: Date.now(),
      };
      if (!this.activeTurns.has(sessionId)) {
        await this.sessions.save(refreshedSession);
      }
      return refreshedSession;
    }

    return session;
  }

  /** UI-only bounded read; command execution and exports still read the full server session. */
  async getSessionDisplaySnapshot(sessionId: string): Promise<SessionSnapshot> {
    const recent = await this.sessions.getRecent?.(sessionId);
    if (!recent) return this.getSessionSnapshot(sessionId);
    return { ...recent, deviceState: await this.options.device.getState() };
  }

  async getSessionExportSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const snapshot = await (this.sessions.getCompleteByPages?.(sessionId) ??
      this.sessions.get(sessionId));
    if (!snapshot) throw new Error('会话不存在或已删除');
    return snapshot;
  }

  /**
   * Restore previously exported sessions into the store. Existing sessions with
   * the same id are overwritten (import acts as backup/restore, not append).
   */
  async importSessions(sessions: SessionSnapshot[]): Promise<void> {
    for (const session of sessions) {
      this.deletedSessionIds.delete(session.id);
      this.sessionTitleOverrides.delete(session.id);
      await this.sessions.save(session);
    }
  }

  async renameSession(sessionId: string, title: string | null): Promise<void> {
    const session = await this.sessions.get(sessionId);
    if (!session || this.isSessionDeleted(sessionId)) {
      throw new Error('会话不存在');
    }

    const normalized = title?.trim().slice(0, 60) ?? '';
    this.sessionTitleOverrides.set(sessionId, normalized || null);
    session.updatedAt = Date.now();
    await this.saveSessionIfAvailable(session);
  }

  /** A scene changes the environment of a personal conversation, never its character binding. */
  async setSessionScene(sessionId: string, sceneId: string | null): Promise<void> {
    if (sceneId !== null && !/^[A-Za-z0-9._:-]{1,200}$/.test(sceneId)) {
      throw new Error('场景编号无效');
    }
    if (this.activeTurns.has(sessionId)) throw new Error('请等待当前回复结束后再切换场景');
    const session = await this.ensureSession(sessionId);
    if (this.activeTurns.has(sessionId)) throw new Error('请等待当前回复结束后再切换场景');
    const metadata = session.metadata;
    if (
      metadata?.bridgeOrigin ||
      metadata?.groupId ||
      metadata?.roomId ||
      metadata?.conversationType === 'group' ||
      metadata?.conversationType === 'dm'
    ) {
      throw new Error('只有私人聊天可以切换场景');
    }
    session.metadata = { ...metadata, sceneId: sceneId ?? '' };
    session.updatedAt = Date.now();
    await this.saveSessionIfAvailable(session);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessionIds.add(sessionId);
    this.sessionTitleOverrides.delete(sessionId);
    await this.abortCurrentReply(sessionId);
    this.toolExecutor.cancelScheduledTimers(sessionId);
    this.pendingSystemWork.delete(sessionId);
    this.drainingSessions.delete(sessionId);
    if (this.sensorTriggerSessionId === sessionId) {
      this.teardownSensorTriggerEngine();
    }
    await this.sessions.delete(sessionId);
    await this.traces.clear(sessionId);
  }

  async connectDevice(): Promise<void> {
    await this.options.device.connect();
  }

  async disconnectDevice(): Promise<void> {
    await this.options.device.disconnect();
  }

  async emergencyStop(sessionId: string): Promise<void> {
    // Latch first: continuations created before this line stay stale even if
    // their provider or permission promise ignores AbortSignal.
    const affectedSessions = new Set([...this.sessionGenerations.keys(), sessionId]);
    for (const affectedSessionId of affectedSessions) {
      this.bumpSessionGeneration(affectedSessionId);
    }
    for (const controller of this.activeTurns.values()) {
      controller.abort();
    }
    this.pendingSystemWork.clear();
    this.toolExecutor.cancelScheduledTimers();
    this.teardownSensorTriggerEngine();
    const linkRule = this.deviceLinkEngine?.getRule();
    if (linkRule?.enabled) {
      this.deviceLinkEngine?.setRule({ ...linkRule, enabled: false });
    }

    const result = await this.stopDevicesBestEffort();
    if (result) {
      this.events.emit({
        type: 'device-command-executed',
        sessionId,
        command: { type: 'emergencyStop' },
        result,
      });
    }
  }

  async abortCurrentReply(sessionId: string): Promise<void> {
    this.activeTurns.get(sessionId)?.abort();
  }

  async sendUserMessage(input: SendUserMessageInput): Promise<void> {
    return this.sendUserMessageAtGeneration(input, this.getSessionGeneration(input.sessionId));
  }

  private async sendUserMessageAtGeneration(
    input: SendUserMessageInput,
    expectedGeneration: number,
  ): Promise<void> {
    if (expectedGeneration !== this.getSessionGeneration(input.sessionId)) {
      if (isInternallyTriggeredSourceType(input.context.sourceType)) return;
      throw new Error(REPLY_ABORTED_ERROR_MESSAGE);
    }
    if (input.image && !this.capabilities.imageInput) {
      throw new Error('当前模型未明确支持图片输入，请切换到支持视觉的模型');
    }
    if (this.options.taskRunReporter && !input.runId && input.context.sourceType === 'web') {
      throw new Error('缺少服务器任务编号，不能开始 Agent 回复');
    }
    if (input.runId && !/^[A-Za-z0-9._:-]{8,128}$/.test(input.runId)) {
      throw new Error('任务编号无效');
    }
    if (input.runId && this.taskRuns.get(input.runId)) {
      throw new Error('任务编号重复，不能重放工具调用');
    }

    if (this.isSessionDeleted(input.sessionId)) {
      if (isInternallyTriggeredSourceType(input.context.sourceType)) {
        return;
      }
      this.deletedSessionIds.delete(input.sessionId);
    }

    if (this.activeTurns.has(input.sessionId)) {
      if (isInternallyTriggeredSourceType(input.context.sourceType)) {
        this.enqueueSystemWork(input.sessionId, {
          kind: 'follow-up',
          input,
          generation: expectedGeneration,
        });
        return;
      }
      throw new Error('当前会话已有回复正在进行中');
    }

    const candidate =
      input.context.sourceType === 'web' && !input.context.sourceChannelId
        ? await this.sessions.getRuntimeWindow?.(input.sessionId)
        : null;
    const stableBinding =
      typeof candidate?.metadata?.promptPresetId === 'string' &&
      candidate.metadata.promptPresetId.length > 0 &&
      !candidate.metadata.bridgeOrigin &&
      !candidate.metadata.groupId &&
      !candidate.metadata.roomId &&
      !['group', 'dm'].includes(String(candidate.metadata.conversationType ?? '')) &&
      (!input.relationshipId || candidate.metadata?.relationshipId === input.relationshipId);
    const session = stableBinding ? candidate! : await this.ensureSession(input.sessionId);
    if (expectedGeneration !== this.getSessionGeneration(input.sessionId)) {
      if (isInternallyTriggeredSourceType(input.context.sourceType)) return;
      throw new Error(REPLY_ABORTED_ERROR_MESSAGE);
    }
    session.metadata = mergeBridgeOriginMetadata(session.metadata, input.context);
    bindSessionCharacter(session, input.context, input.characterId, input.relationshipId);
    const persistIncomingMessage = input.persistMessage ?? input.context.sourceType !== 'system';
    const incomingMessage = persistIncomingMessage ? createIncomingMessage(input) : null;
    const abortController = new AbortController();
    const ephemeralInput = persistIncomingMessage
      ? null
      : ({
          kind: 'message',
          role: 'user',
          content: input.text,
        } satisfies LlmConversationItem);

    let turnStartIndex = session.messages.length - 1;
    if (incomingMessage) {
      session.messages.push(incomingMessage);
      session.updatedAt = Date.now();
      await this.saveSessionIfAvailable(session);
      // A concurrent device may have appended messages before this turn while the
      // server store rebased our accepted user message. Keep assistant deduplication
      // anchored to the actual user message, not its former array position.
      turnStartIndex = session.messages.findIndex((message) => message.id === incomingMessage.id);

      this.events.emit({
        type: 'user-message-accepted',
        sessionId: session.id,
        message: incomingMessage,
        sourceType: input.context.sourceType,
      });
    }

    const runId = input.runId ?? createLocalRunId();
    const reporter = input.runId ? this.options.taskRunReporter : undefined;
    const withoutServerRun = Boolean(this.options.taskRunReporter && !input.runId);
    this.notifyTaskRun(
      this.taskRuns.begin({
        runId,
        sessionId: session.id,
        requestId: input.context.traceId,
      }),
    );
    this.activeTurns.set(session.id, abortController);

    try {
      await reporter?.begin({
        runId,
        sessionId: session.id,
        requestId: input.context.traceId,
        sourceType: input.context.sourceType,
      });
      const turnResult = await this.turnCoordinator.run({
        session,
        turn: input,
        turnStartIndex,
        ephemeralInput,
        abortSignal: abortController.signal,
        runId,
        allowTools: !withoutServerRun,
        hooks: {
          beforeToolCall: withoutServerRun
            ? async () => {
                throw new Error('没有服务器任务编号，不能执行工具');
              }
            : reporter
              ? ({ callId, name }) =>
                  reporter.beforeToolCall({
                    runId,
                    sessionId: session.id,
                    callId,
                    name,
                  })
              : undefined,
          onToolCallStarted: ({ callId, name }) => {
            this.notifyTaskRun(this.taskRuns.startCall(runId, callId, name));
          },
          recordToolReceipt: reporter
            ? (receipt) =>
                reporter.recordReceipt({
                  runId,
                  sessionId: session.id,
                  callId: receipt.callId,
                  name: receipt.name,
                  status: receipt.status,
                  provenance: 'client-reported',
                })
            : undefined,
          onToolReceipt: (receipt) => {
            this.notifyTaskRun(this.taskRuns.record(receipt));
          },
        },
      });
      throwIfAborted(abortController.signal);

      let finalAssistantText = turnResult.finalAssistantText;
      try {
        await reporter?.finish({
          runId,
          sessionId: session.id,
          status: turnResult.status,
        });
        this.notifyTaskRun(this.taskRuns.finish(runId, turnResult.status));
      } catch {
        this.notifyTaskRun(this.taskRuns.finish(runId, 'needs-review'));
        finalAssistantText = '任务状态尚未确认。请核对工具记录和实际结果后再决定是否重试。';
      }

      const assistantMessage = appendAssistantMessage(
        session,
        { content: finalAssistantText },
        turnStartIndex,
      );
      session.updatedAt = Date.now();
      session.deviceState = await this.options.device.getState();
      await this.saveSessionIfAvailable(session);

      this.events.emit({
        type: 'assistant-message-completed',
        sessionId: session.id,
        message: assistantMessage,
        sourceType: input.context.sourceType,
      });
    } catch (error) {
      await this.closeInterruptedTaskRun(
        runId,
        session.id,
        abortController.signal.aborted || isAbortError(error) ? 'aborted' : 'failed',
        reporter,
      );
      if (abortController.signal.aborted || isAbortError(error)) {
        const abortedMessage = appendAssistantMessage(
          session,
          { content: REPLY_ABORTED_NOTE },
          turnStartIndex,
        );
        session.updatedAt = Date.now();
        session.deviceState = await this.options.device.getState();
        await this.saveSessionIfAvailable(session);

        this.events.emit({
          type: 'assistant-message-aborted',
          sessionId: session.id,
          reason: REPLY_ABORTED_ERROR_MESSAGE,
          message: abortedMessage,
          sourceType: input.context.sourceType,
        });
        throw new Error(REPLY_ABORTED_ERROR_MESSAGE, { cause: error });
      }

      // Product rule: provider failures are page-only notices. The accepted user message
      // stays in the record so the user can resend; the error text is never persisted.
      const failedMessage = createMessage('assistant', normalizeAssistantErrorMessage(error));
      this.events.emit({
        type: 'assistant-message-failed',
        sessionId: session.id,
        message: failedMessage,
        sourceType: input.context.sourceType,
      });
    } finally {
      if (this.activeTurns.get(session.id) === abortController) {
        this.activeTurns.delete(session.id);
      }
      queueMicrotask(() => {
        void this.drainSystemWork(session.id);
      });
    }
  }

  private async processTimerTrigger(trigger: TimerFiredTrigger): Promise<void> {
    if (
      trigger.generation !== this.getSessionGeneration(trigger.sessionId) ||
      this.isSessionDeleted(trigger.sessionId)
    ) {
      return;
    }
    await this.ensureSession(trigger.sessionId);
    await this.traces.append(trigger.sessionId, {
      kind: 'timer-fired',
      turnId: `timer-${trigger.firedAt}`,
      sourceType: 'system',
      synthetic: true,
      label: trigger.label,
      seconds: trigger.seconds,
      firedAt: trigger.firedAt,
    });

    await this.sendUserMessageAtGeneration(
      {
        sessionId: trigger.sessionId,
        text: buildTimerTriggerPrompt(trigger),
        context: {
          sessionId: trigger.sessionId,
          sourceType: 'system',
          traceId: `timer-${trigger.firedAt}`,
        },
        persistMessage: false,
      },
      trigger.generation,
    );
  }

  /**
   * Mirrors `processTimerTrigger`: a `SensorFiredTrigger` from the Sensor
   * Trigger Engine becomes a trace entry plus one ephemeral, non-persisted
   * system turn — never a raw sensor reading forwarded verbatim, and never
   * written into `session.messages` (see docs/architecture.md's "ephemeral
   * trigger" concept).
   */
  private async processSensorTrigger(
    trigger: SensorFiredTrigger,
    expectedGeneration: number,
  ): Promise<void> {
    if (
      expectedGeneration !== this.getSessionGeneration(trigger.sessionId) ||
      this.isSessionDeleted(trigger.sessionId)
    ) {
      return;
    }
    // Defense in depth: even though `setSensorTriggersEnabled(false)` tears
    // down the engine (so this shouldn't normally fire once disabled), a
    // trigger emitted just before teardown could still be in flight in the
    // system-work queue. Re-check the persisted flag before acting on it.
    if (!(await this.isSensorTriggersEnabledForSession(trigger.sessionId))) {
      return;
    }
    const session = await this.ensureSession(trigger.sessionId);
    session.metadata = withSensorLastReading(session.metadata, trigger.deviceKind, {
      summary: trigger.summary,
      firedAt: trigger.firedAt,
    });
    session.updatedAt = Date.now();
    await this.saveSessionIfAvailable(session);
    await this.traces.append(trigger.sessionId, {
      kind: 'sensor-fired',
      turnId: `sensor-${trigger.firedAt}`,
      sourceType: 'sensor',
      synthetic: true,
      detail: trigger.summary,
      firedAt: trigger.firedAt,
    });

    // sourceType: 'sensor' (not 'system') deliberately — a sensor event is a
    // real, physical signal the user caused (unlike a timer firing), so it's
    // allowed to carry tools through runToolLoop's tool-list gate (which
    // only empties tools for 'system'). All the usual safety layers still
    // apply in full: filterToolDefinitionsByConnectedDevices, permission
    // gate, policy clamps, per-turn caps — this only lifts the blanket
    // "system turns never touch the device" rule for this one case.
    const { pawPrintsSummary, civetSummary } = this.getSensorSummaries();
    const trendSummary =
      trigger.deviceKind === 'paw-prints'
        ? pawPrintsSummary
        : trigger.deviceKind === 'civet-edging'
          ? civetSummary
          : undefined;
    await this.sendUserMessageAtGeneration(
      {
        sessionId: trigger.sessionId,
        text: buildSensorTriggerPrompt(trigger, trendSummary),
        context: {
          sessionId: trigger.sessionId,
          sourceType: 'sensor',
          traceId: `sensor-${trigger.firedAt}`,
        },
        persistMessage: false,
      },
      expectedGeneration,
    );
  }

  /** Fetches live auxiliary state; instruction composition filters disconnected devices. */
  private async getAuxDeviceStatesForInstructions(): Promise<{
    coyoteTargets?: Awaited<ReturnType<CoyoteTargetRouter['listTargets']>>;
    opossumState?: OpossumState;
    pawPrintsState?: SensorState;
    civetEdgingState?: SensorState;
    pawPrintsSummary?: string;
    civetSummary?: string;
  }> {
    const [coyoteTargets, opossumState, pawPrintsState, civetEdgingState] = await Promise.all([
      this.options.coyoteTargetRouter?.listTargets(),
      this.options.opossum?.getState(),
      this.options.pawPrints?.getState(),
      this.options.civetEdging?.getState(),
    ]);
    const { pawPrintsSummary, civetSummary } = this.getSensorSummaries();
    return {
      coyoteTargets,
      opossumState,
      pawPrintsState,
      civetEdgingState,
      pawPrintsSummary,
      civetSummary,
    };
  }

  /** Synchronous — the buffers already hold everything they need in memory. */
  private getSensorSummaries(): { pawPrintsSummary?: string; civetSummary?: string } {
    return {
      pawPrintsSummary:
        summarizePawPrintsTriggers(this.pawPrintsBuffer?.windowEntries() ?? []) ?? undefined,
      civetSummary: summarizeCivetPressure(this.civetBuffer?.windowEntries() ?? []) ?? undefined,
    };
  }

  private async ensureSession(sessionId: string): Promise<SessionSnapshot> {
    const existing = await this.sessions.get(sessionId);
    if (existing) {
      if (normalizeSessionHistory(existing)) {
        await this.saveSessionIfAvailable(existing);
      }
      return existing;
    }

    const now = Date.now();
    const created: SessionSnapshot = {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      messages: [],
      deviceState: createEmptyDeviceState(),
    };

    await this.saveSessionIfAvailable(created);
    return created;
  }

  private enqueueSystemWork(sessionId: string, work: QueuedSystemWork): void {
    if (work.generation !== this.getSessionGeneration(sessionId)) return;
    const queue = this.pendingSystemWork.get(sessionId) ?? [];
    queue.push(work);
    this.pendingSystemWork.set(sessionId, queue);
    queueMicrotask(() => {
      void this.drainSystemWork(sessionId);
    });
  }

  private async drainSystemWork(sessionId: string): Promise<void> {
    if (
      this.activeTurns.has(sessionId) ||
      this.drainingSessions.has(sessionId) ||
      this.isSessionDeleted(sessionId)
    )
      return;

    const queue = this.pendingSystemWork.get(sessionId);
    if (!queue || queue.length === 0) return;

    this.drainingSessions.add(sessionId);
    try {
      while (!this.activeTurns.has(sessionId)) {
        if (this.isSessionDeleted(sessionId)) {
          this.pendingSystemWork.delete(sessionId);
          break;
        }
        const currentQueue = this.pendingSystemWork.get(sessionId);
        const next = currentQueue?.shift();
        if (!next) {
          this.pendingSystemWork.delete(sessionId);
          break;
        }
        if (next.generation !== this.getSessionGeneration(sessionId)) {
          continue;
        }
        if (!currentQueue || currentQueue.length === 0) {
          this.pendingSystemWork.delete(sessionId);
        } else {
          this.pendingSystemWork.set(sessionId, currentQueue);
        }

        if (next.kind === 'timer-fired') {
          await this.processTimerTrigger(next.trigger);
          continue;
        }

        if (next.kind === 'sensor-fired') {
          await this.processSensorTrigger(next.trigger, next.generation);
          continue;
        }

        await this.sendUserMessageAtGeneration(next.input, next.generation);
      }
    } finally {
      this.drainingSessions.delete(sessionId);
    }
  }

  private async saveSessionIfAvailable(session: SessionSnapshot): Promise<void> {
    if (this.isSessionDeleted(session.id)) {
      return;
    }
    if (this.sessionTitleOverrides.has(session.id)) {
      const title = this.sessionTitleOverrides.get(session.id);
      const metadata = { ...session.metadata };
      if (title) {
        metadata[SESSION_TITLE_METADATA_KEY] = title;
      } else {
        delete metadata[SESSION_TITLE_METADATA_KEY];
      }
      session.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
    }
    await this.sessions.save(session);
  }

  private canExecuteDeviceLink(): boolean | Promise<boolean> {
    if (!this.options.deviceExecutionGate) return true;
    const sessionId = this.sensorTriggerSessionId ?? 'device-link';
    return this.options.deviceExecutionGate({
      sessionId,
      context: { sessionId, sourceType: 'sensor', traceId: 'device-link' },
      deviceKind: 'opossum',
      toolName: 'device-link',
      command: { type: 'vibrateStart', channel: 'A', intensity: 0 },
    });
  }

  private getSessionGeneration(sessionId: string): number {
    const existing = this.sessionGenerations.get(sessionId);
    if (existing !== undefined) return existing;
    this.sessionGenerations.set(sessionId, 0);
    return 0;
  }

  private bumpSessionGeneration(sessionId: string): number {
    const next = this.getSessionGeneration(sessionId) + 1;
    this.sessionGenerations.set(sessionId, next);
    return next;
  }

  private async stopDevicesBestEffort(): Promise<Awaited<
    ReturnType<DeviceCommandQueue['emergencyStop']>
  > | null> {
    const [coyote] = await Promise.allSettled([
      Promise.all([
        this.queue.emergencyStop(),
        this.toolExecutor.emergencyStopCoyoteTargetQueues(),
      ]).then(([result]) => result),
      this.opossumQueue?.emergencyStop() ?? Promise.resolve(undefined),
    ]);
    return coyote.status === 'fulfilled' ? coyote.value : null;
  }

  private isSessionDeleted(sessionId: string): boolean {
    return this.deletedSessionIds.has(sessionId);
  }

  private notifyTaskRun(snapshot: RuntimeTaskRunSnapshot): void {
    try {
      this.options.onTaskRunUpdate?.(snapshot);
    } catch {
      // Observation cannot affect execution or the emergency stop path.
    }
  }

  private async closeInterruptedTaskRun(
    runId: string,
    sessionId: string,
    status: Extract<RuntimeTaskRunStatus, 'aborted' | 'failed'>,
    reporter?: RuntimeTaskRunReporter,
  ): Promise<void> {
    if (this.taskRuns.get(runId)?.status !== 'running') return;
    const snapshot = this.taskRuns.finish(runId, status);
    this.notifyTaskRun(snapshot);
    try {
      if (snapshot.status === 'running') throw new Error('任务未结束');
      await reporter?.finish({ runId, sessionId, status: snapshot.status });
    } catch {
      this.notifyTaskRun(this.taskRuns.markNeedsReview(runId));
    }
  }
}

type QueuedSystemWork =
  | {
      kind: 'follow-up';
      input: SendUserMessageInput;
      generation: number;
    }
  | {
      kind: 'timer-fired';
      trigger: TimerFiredTrigger;
      generation: number;
    }
  | {
      kind: 'sensor-fired';
      trigger: SensorFiredTrigger;
      generation: number;
    };

function createIncomingMessage(input: SendUserMessageInput): ConversationMessage {
  const message = createMessage('user', input.text);
  // The server's requestId equals this message ID, so a recovered run can be
  // traced back to the initiating message without storing tool data in the transcript.
  if (input.runId) message.id = input.context.traceId;
  return message;
}

function createLocalRunId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `local-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function buildTimerTriggerPrompt(trigger: TimerFiredTrigger): string {
  return [
    `[内部提醒] 你之前设置的定时“${trigger.label}”已到期。`,
    '这不是用户的新消息，用户没有提供新的反馈。',
    '请基于当前设备状态和最近一轮对话做一次简短跟进，不要自动操作设备，也不要再次设置定时。',
  ].join('\n');
}

/**
 * Mirrors `buildTimerTriggerPrompt`'s tone/structure: state what happened,
 * make explicit this isn't a real user message, then a guardrail line — but
 * unlike a timer firing, this turn's tools are NOT emptied (sourceType:
 * 'sensor', not 'system' — see runToolLoop), so the guardrail here has to
 * spell out how to use that access responsibly rather than just forbidding
 * it: a sensor trigger is a plausible signal the user actually wants a
 * reaction to, just not an automatic or repeated one. All the usual policy
 * clamps/permission gate/per-turn caps still apply in full to any tool call
 * made here — this prompt is guidance, not the safety boundary itself.
 */
function buildSensorTriggerPrompt(trigger: SensorFiredTrigger, trendSummary?: string): string {
  return [
    `[内部提醒] 传感器事件：${trigger.summary}。`,
    ...(trendSummary ? [`近段汇总：${trendSummary}`] : []),
    '这不是用户的新消息，用户没有提供新的反馈。',
    '你可以按当前剧情自行判断是否需要用工具做出响应，但最多只推进一小步就停下观察，不要连续加码或反复触发；同样不得超过任何强度/次数上限。',
    '如果只是想确认状态或不确定该不该动，直接不调用工具、简短观察即可。',
  ].join('\n');
}

/** Timer/sensor triggers are internal signals, not a direct user action —
 * they must never resurrect a deleted session or bypass the single-active-turn
 * invariant by throwing (queue instead, mirroring the existing 'system' case). */
function isInternallyTriggeredSourceType(sourceType: SourceType): boolean {
  return sourceType === 'system' || sourceType === 'sensor';
}
