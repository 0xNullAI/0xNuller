/**
 * Device tools for a group AI.
 *
 * The RoomDO is the only place a group AI's tool call becomes a device command. It offers the
 * model only members whose own client said, in its latest state report, that it lets this
 * particular AI control it. That report is a hint for the model, never the permission itself:
 * the target's device checks its own stored consent, its lease and its limits before acting,
 * and answers with what really happened.
 */

/** A member's report is trusted for targeting only while its heartbeat is fresh. */
export const SNAPSHOT_TTL_MS = 15_000;
/** Largest step one tool call may move a channel; the holder still clamps to its own limit. */
export const MAX_AGENT_STEP = 10;
/** Tool calls the RoomDO runs from a single model reply. */
export const MAX_TOOL_CALLS_PER_ROUND = 4;
const MAX_WAVES = 40;

export interface PeerSnapshot {
  account: string;
  name: string;
  at: number;
  /** AIs this member's client allows to control it in this group. Absent on older clients. */
  allowed: string[];
  coyote: boolean;
  opossum: boolean;
  strengthA: number;
  strengthB: number;
  opossumA: number;
  opossumB: number;
  waves: { id: string; name: string }[];
}

export interface AgentTarget {
  /** Short label the model uses; peer ids never reach the prompt. */
  label: string;
  peerId: string;
  snapshot: PeerSnapshot;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Fold a slow state report into the snapshot. Only a client that sends `ag` can be a target. */
export function snapshotFromSlow(
  prev: PeerSnapshot | undefined,
  account: string,
  msg: Record<string, unknown>,
  now: number,
): PeerSnapshot | undefined {
  if (!Array.isArray(msg.ag)) return undefined;
  const allowed = msg.ag
    .filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id))
    .slice(0, 8);
  const waves = Array.isArray(msg.cat)
    ? msg.cat
        .flatMap((entry) => {
          const record = entry as { id?: unknown; name?: unknown; modality?: unknown } | null;
          return typeof record?.id === 'string' &&
            record.id.length <= 128 &&
            typeof record.name === 'string' &&
            record.modality !== 'vibration'
            ? [{ id: record.id, name: record.name.slice(0, 40) }]
            : [];
        })
        .slice(0, MAX_WAVES)
    : (prev?.waves ?? []);
  return {
    account,
    name: typeof msg.n === 'string' && msg.n.trim() ? msg.n.trim().slice(0, 40) : '成员',
    at: now,
    allowed,
    coyote: msg.dc === true && Array.isArray(msg.cy) && msg.cy.length > 0,
    opossum: msg.oc === true,
    strengthA: prev?.strengthA ?? 0,
    strengthB: prev?.strengthB ?? 0,
    opossumA: prev?.opossumA ?? 0,
    opossumB: prev?.opossumB ?? 0,
    waves,
  };
}

/** Fold a fast report (current output) into an existing snapshot. */
export function snapshotFromFast(
  prev: PeerSnapshot | undefined,
  msg: Record<string, unknown>,
): PeerSnapshot | undefined {
  if (!prev) return undefined;
  return {
    ...prev,
    strengthA: finite(msg.sa, prev.strengthA),
    strengthB: finite(msg.sb, prev.strengthB),
    opossumA: finite(msg.oa, prev.opossumA),
    opossumB: finite(msg.ob, prev.opossumB),
  };
}

/** Members this AI may try to control right now, in a stable order. */
export function agentTargets(
  snapshots: ReadonlyMap<string, PeerSnapshot>,
  agentId: string,
  now: number,
  stillHere: (peerId: string, account: string) => boolean,
): AgentTarget[] {
  return [...snapshots.entries()]
    .filter(
      ([peerId, snapshot]) =>
        snapshot.allowed.includes(agentId) &&
        now - snapshot.at <= SNAPSHOT_TTL_MS &&
        (snapshot.coyote || snapshot.opossum) &&
        stillHere(peerId, snapshot.account),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, 8)
    .map(([peerId, snapshot], index) => ({ label: `t${index + 1}`, peerId, snapshot }));
}

/** What the model is told about its targets; names are untrusted and are quoted. */
export function describeTargets(targets: AgentTarget[]): string {
  if (targets.length === 0)
    return '目前没有成员允许你控制设备。如果有人让你操作设备，告诉他需要对方先在「群 AI」里允许你。';
  const lines = targets.map(({ label, snapshot }) => {
    const parts: string[] = [];
    if (snapshot.coyote)
      parts.push(
        `郊狼已连接（A 通道 ${snapshot.strengthA}，B 通道 ${snapshot.strengthB}）${
          snapshot.waves.length
            ? `，可用波形：${snapshot.waves.map((wave) => `「${wave.name}」`).join('、')}`
            : ''
        }`,
      );
    if (snapshot.opossum)
      parts.push(`负鼠已连接（A ${snapshot.opossumA}，B ${snapshot.opossumB}）`);
    return `- ${label}：「${snapshot.name}」，${parts.join('；')}`;
  });
  return [
    '以下成员允许你控制他们的设备，调用工具时用目标编号：',
    ...lines,
    '其他成员没有允许你，不能控制他们；被要求时告诉对方需要本人先在「群 AI」里允许你。',
    `每次调整最多 ±${MAX_AGENT_STEP}，从小幅度开始。对方设备会再按自己的上限限制并返回实际结果；只根据工具结果描述发生了什么。有人要求停止时立即停止。`,
  ].join('\n');
}

const target = { type: 'string', description: '目标编号，例如 t1' };
const channel = { type: 'string', enum: ['A', 'B'], description: '通道' };
const delta = {
  type: 'integer',
  minimum: -MAX_AGENT_STEP,
  maximum: MAX_AGENT_STEP,
  description: '变化量，正数增强，负数减弱',
};

function tool(name: string, description: string, properties: Record<string, unknown>) {
  return {
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required: Object.keys(properties) },
    },
  };
}

export const AGENT_DEVICE_TOOLS = [
  tool('adjust_strength', '调整对方郊狼某个通道的强度', { target, channel, delta }),
  tool('set_wave', '切换对方郊狼某个通道的波形并开始输出', {
    target,
    channel,
    waveform: { type: 'string', description: '波形名称' },
  }),
  tool('stop_channel', '暂停对方郊狼某个通道的输出', { target, channel }),
  tool('stop_all', '立即停止对方所有设备的输出', { target }),
  tool('adjust_vibration', '调整对方负鼠某个通道的振动强度', { target, channel, delta }),
];

/** The device command a tool call becomes, or the reason it is refused before sending. */
export type ToolCommand =
  | {
      ok: true;
      target: AgentTarget;
      command: { a: string; c?: 'A' | 'B'; v?: number; w?: string; kind?: string };
      summary: string;
    }
  | { ok: false; message: string };

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function toolCommand(
  call: { function?: { name?: unknown; arguments?: unknown } },
  targets: AgentTarget[],
): ToolCommand {
  const name = call.function?.name;
  const args = parseArgs(call.function?.arguments);
  if (!args) return { ok: false, message: '参数格式错误' };
  const chosen = targets.find((candidate) => candidate.label === args.target);
  if (!chosen) return { ok: false, message: '目标不存在或没有允许你控制' };
  const who = chosen.snapshot.name;
  const ch = args.channel === 'A' || args.channel === 'B' ? args.channel : null;
  const step =
    typeof args.delta === 'number' && Number.isFinite(args.delta)
      ? Math.max(-MAX_AGENT_STEP, Math.min(MAX_AGENT_STEP, Math.round(args.delta)))
      : null;
  switch (name) {
    case 'stop_all':
      return {
        ok: true,
        target: chosen,
        command: { a: 'stop' },
        summary: `停止了「${who}」的全部输出`,
      };
    case 'stop_channel':
      if (!ch) return { ok: false, message: '通道须为 A 或 B' };
      return {
        ok: true,
        target: chosen,
        command: { a: 'stop_wave', c: ch },
        summary: `暂停了「${who}」的 ${ch} 通道`,
      };
    case 'adjust_strength':
      if (!chosen.snapshot.coyote) return { ok: false, message: '对方没有连接郊狼' };
      if (!ch || !step) return { ok: false, message: '需要通道和非零的变化量' };
      return {
        ok: true,
        target: chosen,
        command: { a: 'adjust_strength', c: ch, v: step },
        summary: `把「${who}」的 ${ch} 通道调整了 ${step > 0 ? '+' : ''}${step}`,
      };
    case 'adjust_vibration':
      if (!chosen.snapshot.opossum) return { ok: false, message: '对方没有连接负鼠' };
      if (!ch || !step) return { ok: false, message: '需要通道和非零的变化量' };
      return {
        ok: true,
        target: chosen,
        command: { a: 'vibrate_adjust', kind: 'opossum', c: ch, v: step },
        summary: `把「${who}」的振动 ${ch} 通道调整了 ${step > 0 ? '+' : ''}${step}`,
      };
    case 'set_wave': {
      if (!chosen.snapshot.coyote) return { ok: false, message: '对方没有连接郊狼' };
      if (!ch) return { ok: false, message: '通道须为 A 或 B' };
      const wanted = typeof args.waveform === 'string' ? args.waveform.trim() : '';
      const wave =
        chosen.snapshot.waves.find((candidate) => candidate.name === wanted) ??
        chosen.snapshot.waves.find((candidate) => candidate.id === wanted);
      if (!wave) return { ok: false, message: '对方没有这个波形' };
      return {
        ok: true,
        target: chosen,
        command: { a: 'change_wave', c: ch, w: wave.id },
        summary: `把「${who}」的 ${ch} 通道切换为「${wave.name}」`,
      };
    }
    default:
      return { ok: false, message: '没有这个工具' };
  }
}
