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
import type {
  MemberState,
  ChatMention,
  CmdAction,
  DeviceCommand,
  ChatMessage,
} from '../lib/protocol';
import { loadAiConfig, isAiConfigured } from '../lib/ai-config';
import { callLlm, type LlmMessage } from '../lib/llm-client';
import {
  applyRoomAgentDeviceTool,
  buildRoomAgentDeviceTools,
  type AgentDeviceTarget,
} from '../lib/room-agent-device-tools';
import { ROOM_AGENT_ID, ROOM_AGENT_SENDER, type RoomAgent } from '../../worker/wire';

export type { AgentDeviceTarget } from '../lib/room-agent-device-tools';

interface RoomAgentsOptions {
  isHost: boolean;
  /** The room's agent, or null when the host has not added one. */
  agent: RoomAgent | null;
  members: Map<string, MemberState>;
  messages: ChatMessage[];
  /** Devices this AI may control (already authorized). Empty array = chat only, no tools offered. */
  deviceTargets: AgentDeviceTarget[];
  sendChatAs: (roleId: string, text: string, mentions?: ChatMention[]) => void;
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
  lines.push(`【你的身份】你是「${agent.name || 'AI'}」，这个聊天房间里的一位participant。`);
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
  const { isHost, agent, messages } = opts;

  const processedRef = useRef<Set<string>>(new Set());
  const busyRef = useRef<Set<string>>(new Set());
  const [thinking, setThinking] = useState<Set<string>>(new Set());
  const initRef = useRef(false);

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
      const cfg = loadAiConfig();
      if (!isAiConfigured(cfg)) return;
      const cur = latest.current;
      if (!cur.agent) return;
      const sys = buildSystemPrompt(cur.agent, cur.members);
      const recent = cur.messages.slice(-HISTORY_LIMIT);
      const convo: LlmMessage[] = recent.map((m) =>
        m.senderId === `ai:${roleId}`
          ? { role: 'assistant', content: m.text }
          : {
              role: 'user',
              content: `${m.senderName}：${m.text}`,
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
        if (res.toolCalls.length === 0 || rounds === MAX_TOOL_ROUNDS) {
          const text = res.text.trim();
          if (text) cur.sendChatAs(roleId, text);
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
    if (!isHost) return;
    // First pass: mark all existing history as processed, so only messages that
    // arrive afterwards can trigger a turn.
    if (!initRef.current) {
      initRef.current = true;
      for (const m of messages) processedRef.current.add(m.id);
      return;
    }
    // One agent per room, at a fixed id — no scene, no role claims.
    if (!agent) return;
    for (const m of messages) {
      if (processedRef.current.has(m.id)) continue;
      if (m.senderId.startsWith('ai:')) {
        processedRef.current.add(m.id);
        continue; // prevent self-triggering
      }
      const mentioned = m.mentions?.map((x) => x.peerId) ?? [];
      if (mentioned.includes(ROOM_AGENT_SENDER)) {
        void runTurn(ROOM_AGENT_ID, m.id);
      } else {
        processedRef.current.add(m.id);
      }
    }
  }, [isHost, messages, agent, runTurn]);

  return { thinking };
}
