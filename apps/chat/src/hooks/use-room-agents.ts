// use-room-agents: the room agent's brain, running in the host's browser.
// Watches room chat; when a message @-mentions the room's agent it builds the
// system prompt, calls the LLM (optionally with device tools), and broadcasts
// the reply back into the room as that agent.
//
// Safety points:
//  - Only the host (isHost) runs it, guaranteeing one @AI produces exactly one
//    reply.
//  - A message whose _from starts with "ai:" never triggers the AI (prevents
//    self-triggering loops).
//  - Device tools go through sendCommandAs → the existing cmd channel, hard
//    clamped against the local cap on the owner side; the AI can only act on
//    deviceTargets (members who have granted control to that AI).
//  - One turn at a time; the tool loop is capped to prevent runaway.
import { useEffect, useRef, useState, useCallback } from 'react';
import type { MemberState, CmdAction, DeviceCommand, ChatMessage } from '../lib/protocol';
import { loadAiConfig, isAiConfigured } from '../lib/ai-config';
import { callLlm, type LlmMessage } from '../lib/llm-client';
import {
  applyRoomAgentDeviceTool,
  buildRoomAgentDeviceTools,
  type AgentDeviceTarget,
} from '../lib/room-agent-device-tools';
import { ROOM_AGENT_ID, type NamedRoomAgent, type RoomAgent } from '../../worker/wire';

export type { AgentDeviceTarget } from '../lib/room-agent-device-tools';

interface RoomAgentsOptions {
  isHost: boolean;
  billingMode?: 'host-byok' | 'managed';
  roomId: string | null;
  /** The room's agent, or null when the host has not added one. */
  agents: NamedRoomAgent[];
  members: Map<string, MemberState>;
  messages: ChatMessage[];
  /** Devices this AI may control (already authorized). Empty array = chat only, no tools offered. */
  deviceTargets: AgentDeviceTarget[];
  requestAgentTurn: (roleId: string, triggerId: string) => Promise<string | null>;
  sendChatAs: (roleId: string, text: string, triggerId: string, grantId: string) => void;
  sendCommandAs: (
    roleId: string,
    target: string,
    action: CmdAction,
    params?: Omit<DeviceCommand, 'action'>,
  ) => void;
}

const MAX_TOOL_ROUNDS = 4;
const HISTORY_LIMIT = 20;

/**
 * The agent's system prompt.
 *
 * It used to be assembled from a scene: the world setting, the full role
 * table, and the agent's own identity as one claimed role. With roleplay
 * gone the persona is just free text the host writes, so this is the whole
 * of it plus who is in the room.
 */
function buildSystemPrompt(agent: RoomAgent, members: Map<string, MemberState>): string {
  const lines: string[] = [];
  lines.push(`【你的身份】你是「${agent.name || 'AI'}」，这个群聊里的一位成员。`);
  if (agent.persona.trim()) {
    lines.push('');
    lines.push('【人设】');
    lines.push(agent.persona.trim());
  }
  const roster = [...members.values()]
    .filter((m) => m.displayName && !m.isAi)
    .map((m) => m.displayName)
    .join('、');
  if (roster) {
    lines.push('');
    lines.push(`【在场成员】${roster}`);
  }
  lines.push('');
  lines.push('【规则】用中文、简短自然；只在被 @ 时回应；如需对设备施加效果，调用提供的工具。');
  return lines.join('\n');
}

export function useRoomAgents(opts: RoomAgentsOptions): { thinking: Set<string> } {
  // Only the top-level effect needs these; the other fields are read inside
  // runTurn via latest.current.
  const { isHost, agents, messages } = opts;

  const processedRef = useRef<Set<string>>(new Set());
  const busyRef = useRef<Set<string>>(new Set());
  const [thinking, setThinking] = useState<Set<string>>(new Set());
  const initRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedRef = useRef(0);

  // Keep the latest values in a ref so the whole turn logic doesn't have to be
  // stuffed into the effect's deps (updated inside an effect, not written to
  // during render).
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  const runTurn = useCallback(async (roleId: string, triggerId: string) => {
    if (busyRef.current.has(roleId)) return;
    busyRef.current.add(roleId);
    setThinking((s) => new Set(s).add(roleId));
    try {
      const cur = latest.current;
      const agent = cur.agents.find((a) => a.id === roleId);
      if (!cur.isHost || cur.billingMode === 'managed' || !agent) return;
      const stillCurrent = () =>
        mountedRef.current &&
        latest.current.roomId === cur.roomId &&
        latest.current.isHost &&
        latest.current.billingMode !== 'managed' &&
        latest.current.agents.some(
          (a) => a.id === roleId && a.name === agent.name && a.persona === agent.persona,
        );
      const cfg = loadAiConfig();
      // The host mode is explicitly BYOK. Managed calls are made by RoomDO and
      // charge the verified member who sent the @ message, never the host's account.
      if (cfg.providerId === 'managed' || !isAiConfigured(cfg)) return;
      const grantId = await cur.requestAgentTurn(roleId, triggerId);
      if (!grantId || !stillCurrent()) return;
      const sys = buildSystemPrompt(agent, cur.members);
      const triggerIndex = cur.messages.findIndex((m) => m.id === triggerId);
      if (triggerIndex < 0) return;
      const recent = cur.messages.slice(
        Math.max(0, triggerIndex + 1 - HISTORY_LIMIT),
        triggerIndex + 1,
      );
      const convo: LlmMessage[] = recent.map((m) =>
        m.senderId === `ai:${roleId}`
          ? { role: 'assistant', content: m.text }
          : {
              role: 'user',
              content: `${m.senderName}：${m.replyTo && !m.replyTo.unavailable ? `[回复 ${m.replyTo.senderName} 的消息：${m.replyTo.text}]\n` : ''}${m.text || (m.media?.kind === 'image' ? '[Image attachment: image content not provided to this group AI]' : m.media?.kind === 'audio' ? '[Audio attachment: audio/transcript not provided to this group AI]' : '')}`,
            },
      );
      const tools = buildRoomAgentDeviceTools(cur.deviceTargets);
      const llmMessages: LlmMessage[] = [{ role: 'system', content: sys }, ...convo];

      let rounds = 0;
      while (rounds <= MAX_TOOL_ROUNDS) {
        const res = await callLlm(cfg, llmMessages, {
          tools: tools.length ? tools : undefined,
          maxTokens: 800,
        });
        if (!stillCurrent()) return;
        if (res.toolCalls.length === 0 || rounds === MAX_TOOL_ROUNDS) {
          const text = res.text.trim();
          if (text) cur.sendChatAs(roleId, text, triggerId, grantId);
          return;
        }
        // Run the tools, feed the results back in, and go another round.
        llmMessages.push({ role: 'assistant', content: res.text || '', toolCalls: res.toolCalls });
        for (const call of res.toolCalls) {
          const result = applyRoomAgentDeviceTool(
            roleId,
            call,
            latest.current.deviceTargets,
            latest.current.sendCommandAs,
          );
          llmMessages.push({
            role: 'tool',
            content: result,
            tool_call_id: call.id,
            name: call.name,
          });
        }
        rounds++;
      }
    } catch (err) {
      console.warn('[DG-Chat] agent turn failed', err);
    } finally {
      busyRef.current.delete(roleId);
      setThinking((s) => {
        const next = new Set(s);
        next.delete(roleId);
        return next;
      });
      // Mark the triggering message as processed.
      processedRef.current.add(triggerId);
    }
  }, []);

  useEffect(() => {
    if (!isHost || opts.billingMode === 'managed') return;
    // First pass: mark all existing history as processed, so only messages that
    // arrive afterwards can trigger a turn.
    if (initRef.current !== opts.roomId) {
      initRef.current = opts.roomId;
      processedRef.current.clear();
      for (const m of messages) if (m.serverConfirmed) processedRef.current.add(m.id);
      return;
    }
    for (const m of messages) {
      if (!m.serverConfirmed) continue;
      if (processedRef.current.has(m.id)) continue;
      processedRef.current.add(m.id);
      const roles = roomAgentResponders(m, agents);
      // Bound the queue so a burst cannot silently accumulate unbounded billable turns.
      if (!roles.length || queuedRef.current >= 4) continue;
      queuedRef.current++;
      queueRef.current = queueRef.current.then(async () => {
        try {
          for (const role of roles) await runTurn(role, m.id);
        } finally {
          queuedRef.current--;
        }
      });
    }
  }, [isHost, messages, agents, runTurn, opts.roomId, opts.billingMode]);

  return { thinking };
}

/** Human mentions only; a group has at most one active AI even when reading old configuration. */
export function roomAgentResponders(message: ChatMessage, agents: NamedRoomAgent[]): string[] {
  if (!message.serverConfirmed || message.senderId.startsWith('ai:')) return [];
  const active = agents.find((agent) => agent.id === ROOM_AGENT_ID) ?? agents[0];
  if (!active) return [];
  return [...new Set((message.mentions ?? []).map((m) => m.peerId))]
    .filter((id) => id === `ai:${active.id}`)
    .slice(0, 1)
    .map((id) => id.slice(3));
}
