import type { RuntimeEvent, RuntimeTraceEntry, SessionSnapshot } from '@dg-agent/core';
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  type SendUserMessageInput,
} from '@dg-agent/runtime';

export interface AgentClient {
  readonly transport: 'embedded' | 'http';
  readonly supportsLiveEvents: boolean;
  listSessions(): Promise<SessionSnapshot[]>;
  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot>;
  getSessionTrace(sessionId: string): Promise<RuntimeTraceEntry[]>;
  /**
   * Restore exported sessions into the store. Sessions sharing an id with an
   * existing one are overwritten. Not all transports support this.
   */
  importSessions(sessions: SessionSnapshot[]): Promise<void>;
  renameSession(sessionId: string, title: string | null): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  connectDevice(sessionId?: string): Promise<void>;
  disconnectDevice(): Promise<void>;
  /** Opt-in gate for the Sensor Trigger Engine — see AgentRuntime's doc comment. */
  setSensorTriggersEnabled(sessionId: string, enabled: boolean): Promise<void>;
  isSensorTriggersEnabledForSession(sessionId: string): Promise<boolean>;
  emergencyStop(sessionId: string): Promise<void>;
  abortCurrentReply(sessionId: string): Promise<void>;
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

  listSessions(): Promise<SessionSnapshot[]> {
    return this.runtime.listSessions();
  }

  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    return this.runtime.getSessionSnapshot(sessionId);
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

  emergencyStop(sessionId: string): Promise<void> {
    return this.runtime.emergencyStop(sessionId);
  }

  abortCurrentReply(sessionId: string): Promise<void> {
    return this.runtime.abortCurrentReply(sessionId);
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
