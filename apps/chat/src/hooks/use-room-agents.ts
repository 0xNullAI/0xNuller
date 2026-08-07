// use-room-agents：房主浏览器里跑的「AI 角色大脑」。
// 监听房间聊天，当某条消息 @ 了由 AI 托管的角色时，组场景+角色 system prompt、
// 调 LLM（可带设备工具），把回复当作该 AI 角色广播回房间。
//
// 安全要点：
//  - 只有房主（isHost）跑，保证一条 @AI 只产生一次回复。
//  - _from 以 "ai:" 开头的消息永不触发 AI（防自触发循环）。
//  - 设备工具走 sendCommandAs → 现有 cmd 通道，owner 端按本地上限硬钳制；
//    AI 只能作用于 deviceTargets（已把控制权授予该 AI 的成员）。
//  - 每角色一次只跑一轮；工具循环封顶，防失控。
import { useEffect, useRef, useState, useCallback } from 'react';
import type { Scene, MemberState, ChatMention, CmdAction, DeviceCommand, ChatMessage } from '../lib/protocol';
import { loadAiConfig, isAiConfigured } from '../lib/ai-config';
import { callLlm, type LlmMessage, type LlmTool, type LlmToolCall } from '../lib/llm-client';

/** AI 可操控的目标设备（已授权给该 AI 角色）。 */
export interface AgentDeviceTarget {
  peerId: string;
  name: string;
}

interface RoomAgentsOptions {
  isHost: boolean;
  scene: Scene | null;
  roleAssignments: Record<string, string>;
  members: Map<string, MemberState>;
  messages: ChatMessage[];
  /** 该 AI 可控制的设备（已授权）。空数组 = AI 仅聊天，不出工具。 */
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

/** 组装某 AI 角色的 system prompt：场景全貌 + 完整角色表 + 自我身份 + 在场名册。 */
function buildSystemPrompt(
  scene: Scene,
  selfRoleId: string,
  members: Map<string, MemberState>,
  roleAssignments: Record<string, string>,
): string {
  const lines: string[] = [];
  lines.push(`【场景】${scene.name}`);
  if (scene.setting) lines.push(`世界观：${scene.setting}`);
  lines.push('');
  lines.push('【角色表】（本场景所有角色，让你了解全局，不只自己）');
  for (const r of scene.roles) {
    const holder = roleAssignments[r.id];
    let who = '（无人扮演）';
    if (holder?.startsWith('ai:')) who = holder === `ai:${selfRoleId}` ? '由你(AI)扮演 ★' : '由 AI 扮演';
    else if (holder) who = `由 ${members.get(holder)?.displayName || '某成员'} 扮演`;
    lines.push(`- ${r.name}：${r.description || '（无描述）'} —— ${who}`);
  }
  const self = scene.roles.find(r => r.id === selfRoleId);
  lines.push('');
  lines.push('【你的身份】');
  lines.push(`你是「${self?.name ?? '未知角色'}」。`);
  if (self?.description) lines.push(`人设：${self.description}`);
  lines.push('始终以这个角色的身份和口吻发言，不要跳出角色，不要承认自己是 AI。');
  lines.push('');
  const roster = [...members.values()]
    .filter(m => m.displayName)
    .map(m => `${m.displayName}${m.roleId ? `(${scene.roles.find(r => r.id === m.roleId)?.name ?? ''})` : ''}`)
    .join('、');
  if (roster) lines.push(`【在场成员】${roster}`);
  lines.push('【规则】用中文、简短自然、符合场景氛围；只在被 @ 时回应；如需对设备施加效果，调用提供的工具。');
  return lines.join('\n');
}

/** 设备工具定义（仅当有授权目标时提供）。 */
function buildTools(targets: AgentDeviceTarget[]): LlmTool[] {
  if (targets.length === 0) return [];
  const targetEnum = targets.map(t => t.peerId);
  const targetDesc = targets.map(t => `${t.peerId}=${t.name}`).join('，');
  return [
    {
      type: 'function',
      function: {
        name: 'adjust_strength',
        description: `调整某成员设备某通道的强度（带符号增量，正=增强/负=减弱，设备端会按本地安全上限钳制）。目标：${targetDesc}`,
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: targetEnum, description: '目标成员 peerId' },
            channel: { type: 'string', enum: ['A', 'B'], description: '通道' },
            delta: { type: 'number', description: '强度增量，建议绝对值不超过 20' },
          },
          required: ['target', 'channel', 'delta'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'stop',
        description: `停止某成员设备的输出。目标：${targetDesc}`,
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: targetEnum, description: '目标成员 peerId' },
            channel: { type: 'string', enum: ['A', 'B'], description: '通道（省略=两个通道）' },
          },
          required: ['target'],
        },
      },
    },
  ];
}

export function useRoomAgents(opts: RoomAgentsOptions): { thinking: Set<string> } {
  // 仅顶层 effect 需要这几个；其余字段在 runTurn 内通过 latest.current 读取。
  const { isHost, scene, roleAssignments, messages } = opts;

  const processedRef = useRef<Set<string>>(new Set());
  const busyRef = useRef<Set<string>>(new Set());
  const [thinking, setThinking] = useState<Set<string>>(new Set());
  const initRef = useRef(false);

  // 最新值用 ref，避免把整个 turn 逻辑塞进 effect 依赖（在 effect 内更新，不在渲染期写 ref）。
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  const runTurn = useCallback(async (roleId: string, triggerId: string) => {
    if (busyRef.current.has(roleId)) return;
    busyRef.current.add(roleId);
    setThinking(s => new Set(s).add(roleId));
    try {
      const cfg = loadAiConfig();
      if (!isAiConfigured(cfg)) return;
      const cur = latest.current;
      if (!cur.scene) return;
      const sys = buildSystemPrompt(cur.scene, roleId, cur.members, cur.roleAssignments);
      const recent = cur.messages.slice(-HISTORY_LIMIT);
      const convo: LlmMessage[] = recent.map(m =>
        m.senderId === `ai:${roleId}`
          ? { role: 'assistant', content: m.text }
          : {
              role: 'user',
              content: `${m.senderName}${m.senderRole ? `(${m.senderRole})` : ''}：${m.text}`,
            },
      );
      const tools = buildTools(cur.deviceTargets);
      const llmMessages: LlmMessage[] = [{ role: 'system', content: sys }, ...convo];

      let rounds = 0;
      while (rounds <= MAX_TOOL_ROUNDS) {
        const res = await callLlm(cfg, llmMessages, { tools: tools.length ? tools : undefined, maxTokens: 800 });
        if (res.toolCalls.length === 0 || rounds === MAX_TOOL_ROUNDS) {
          const text = res.text.trim();
          if (text) cur.sendChatAs(roleId, text);
          return;
        }
        // 执行工具，回灌结果，再来一轮。
        llmMessages.push({ role: 'assistant', content: res.text || '' });
        for (const call of res.toolCalls) {
          const result = applyTool(roleId, call, cur.deviceTargets, cur.sendCommandAs);
          llmMessages.push({ role: 'tool', content: result, tool_call_id: call.id, name: call.name });
        }
        rounds++;
      }
    } catch (err) {
      console.warn('[DG-Chat] agent turn failed', err);
    } finally {
      busyRef.current.delete(roleId);
      setThinking(s => {
        const next = new Set(s);
        next.delete(roleId);
        return next;
      });
      // 标记触发消息已处理。
      processedRef.current.add(triggerId);
    }
  }, []);

  useEffect(() => {
    if (!isHost) return;
    // 首次：把已有历史全部标记为已处理，只对之后的新消息触发。
    if (!initRef.current) {
      initRef.current = true;
      for (const m of messages) processedRef.current.add(m.id);
      return;
    }
    const aiRoleIds = new Set(
      Object.entries(roleAssignments)
        .filter(([roleId, holder]) => holder === `ai:${roleId}`)
        .map(([roleId]) => roleId),
    );
    if (aiRoleIds.size === 0) return;
    for (const m of messages) {
      if (processedRef.current.has(m.id)) continue;
      if (m.senderId.startsWith('ai:')) {
        processedRef.current.add(m.id);
        continue; // 防自触发
      }
      const mentioned = m.mentions?.map(x => x.peerId) ?? [];
      let handled = false;
      for (const roleId of aiRoleIds) {
        if (mentioned.includes(`ai:${roleId}`)) {
          void runTurn(roleId, m.id);
          handled = true;
        }
      }
      if (!handled) processedRef.current.add(m.id);
    }
  }, [isHost, messages, roleAssignments, scene, runTurn]);

  return { thinking };
}

/** 执行一个工具调用，返回给 LLM 的结果文本。 */
function applyTool(
  roleId: string,
  call: LlmToolCall,
  targets: AgentDeviceTarget[],
  sendCommandAs: RoomAgentsOptions['sendCommandAs'],
): string {
  const target = String(call.arguments.target ?? '');
  if (!targets.some(t => t.peerId === target)) return `错误：目标 ${target} 未授权或不存在`;
  const channel = call.arguments.channel === 'B' ? 'B' : call.arguments.channel === 'A' ? 'A' : undefined;
  if (call.name === 'adjust_strength') {
    const delta = Math.max(-50, Math.min(50, Number(call.arguments.delta) || 0));
    sendCommandAs(roleId, target, 'adjust_strength', { c: channel ?? 'A', v: delta });
    return `已对 ${target} 通道${channel ?? 'A'} 调整强度 ${delta > 0 ? '+' : ''}${delta}（设备端按本地上限钳制）`;
  }
  if (call.name === 'stop') {
    if (channel) sendCommandAs(roleId, target, 'stop', { c: channel });
    else {
      sendCommandAs(roleId, target, 'stop', { c: 'A' });
      sendCommandAs(roleId, target, 'stop', { c: 'B' });
    }
    return `已停止 ${target} ${channel ?? '全部'}通道输出`;
  }
  return `未知工具：${call.name}`;
}
