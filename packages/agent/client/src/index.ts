import type {
  DeviceLinkRule,
  LlmCapabilities,
  RuntimeEvent,
  RuntimeTraceEntry,
  SessionMessagePage,
  SessionSnapshot,
} from '@dg-agent/core';
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type SendUserMessageInput,
} from '@dg-agent/runtime';

export interface AgentClient {
  readonly transport: 'embedded' | 'http';
  readonly supportsLiveEvents: boolean;
  readonly capabilities: LlmCapabilities;
  listSessions(): Promise<SessionSnapshot[]>;
  searchSessions(query: string): Promise<string[]>;
  getSessionMessagesPage(sessionId: string, before?: number): Promise<SessionMessagePage>;
  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot>;
  getSessionDisplaySnapshot(sessionId: string): Promise<SessionSnapshot>;
  getSessionExportSnapshot(sessionId: string): Promise<SessionSnapshot>;
  getSessionTrace(sessionId: string): Promise<RuntimeTraceEntry[]>;
  /**
   * Restore exported sessions into the store. Sessions sharing an id with an
   * existing one are overwritten. Not all transports support this.
   */
  importSessions(sessions: SessionSnapshot[]): Promise<void>;
  renameSession(sessionId: string, title: string | null): Promise<void>;
  setSessionScene(sessionId: string, sceneId: string | null): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  connectDevice(sessionId?: string): Promise<void>;
  disconnectDevice(): Promise<void>;
  /** Opt-in gate for the Sensor Trigger Engine — see AgentRuntime's doc comment. */
  setSensorTriggersEnabled(sessionId: string, enabled: boolean): Promise<void>;
  isSensorTriggersEnabledForSession(sessionId: string): Promise<boolean>;
  setDeviceLinkRule(rule: DeviceLinkRule): Promise<void>;
  getDeviceLinkRule(): DeviceLinkRule | null;
  emergencyStop(sessionId: string): Promise<void>;
  /**
   * Lease loss: drop in-flight turns, timers, triggers and the device link without a device
   * write. The lease owner already stopped every output.
   */
  releaseDeviceControl(sessionId: string): Promise<void>;
  abortCurrentReply(sessionId: string): Promise<void>;
  /** Whether a reply for this session is running or still starting, whoever started it. */
  isReplyRunning?(sessionId: string): boolean;
  sendUserMessage(input: SendUserMessageInput): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  /**
   * Release resources held by the client (device listeners, pending timers,
   * in-flight turns). Safe to call multiple times. Implementations that don't
   * own resources may make this a no-op.
   */
  dispose?(): void;
}

class EmbeddedAgentClient implements AgentClient {
  readonly transport = 'embedded' as const;
  readonly supportsLiveEvents = true;

  constructor(private readonly runtime: AgentRuntime) {}

  get capabilities(): LlmCapabilities {
    return this.runtime.capabilities;
  }

  listSessions(): Promise<SessionSnapshot[]> {
    return this.runtime.listSessions();
  }

  searchSessions(query: string): Promise<string[]> {
    return this.runtime.searchSessions(query);
  }

  getSessionMessagesPage(sessionId: string, before?: number): Promise<SessionMessagePage> {
    return this.runtime.getSessionMessagesPage(sessionId, before);
  }

  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    return this.runtime.getSessionSnapshot(sessionId);
  }

  getSessionDisplaySnapshot(sessionId: string): Promise<SessionSnapshot> {
    return this.runtime.getSessionDisplaySnapshot(sessionId);
  }

  getSessionExportSnapshot(sessionId: string): Promise<SessionSnapshot> {
    return this.runtime.getSessionExportSnapshot(sessionId);
  }

  getSessionTrace(sessionId: string): Promise<RuntimeTraceEntry[]> {
    return this.runtime.getSessionTrace(sessionId);
  }

  importSessions(sessions: SessionSnapshot[]): Promise<void> {
    return this.runtime.importSessions(sessions);
  }

  renameSession(sessionId: string, title: string | null): Promise<void> {
    return this.runtime.renameSession(sessionId, title);
  }

  setSessionScene(sessionId: string, sceneId: string | null): Promise<void> {
    return this.runtime.setSessionScene(sessionId, sceneId);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.runtime.deleteSession(sessionId);
  }

  connectDevice(_sessionId?: string): Promise<void> {
    return this.runtime.connectDevice();
  }

  disconnectDevice(): Promise<void> {
    return this.runtime.disconnectDevice();
  }

  setSensorTriggersEnabled(sessionId: string, enabled: boolean): Promise<void> {
    return this.runtime.setSensorTriggersEnabled(sessionId, enabled);
  }

  isSensorTriggersEnabledForSession(sessionId: string): Promise<boolean> {
    return this.runtime.isSensorTriggersEnabledForSession(sessionId);
  }

  setDeviceLinkRule(rule: DeviceLinkRule): Promise<void> {
    this.runtime.setDeviceLinkRule(rule);
    return Promise.resolve();
  }

  getDeviceLinkRule(): DeviceLinkRule | null {
    return this.runtime.getDeviceLinkRule();
  }

  emergencyStop(sessionId: string): Promise<void> {
    return this.runtime.emergencyStop(sessionId);
  }

  releaseDeviceControl(sessionId: string): Promise<void> {
    this.runtime.releaseDeviceControl(sessionId);
    return Promise.resolve();
  }

  abortCurrentReply(sessionId: string): Promise<void> {
    return this.runtime.abortCurrentReply(sessionId);
  }

  isReplyRunning(sessionId: string): boolean {
    return this.runtime.isReplyRunning(sessionId);
  }

  sendUserMessage(input: SendUserMessageInput): Promise<void> {
    return this.runtime.sendUserMessage(input);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    return this.runtime.subscribe(listener);
  }

  dispose(): void {
    this.runtime.dispose();
  }
}

export function createEmbeddedAgentClient(options: AgentRuntimeOptions): AgentClient {
  return new EmbeddedAgentClient(new AgentRuntime(options));
}
