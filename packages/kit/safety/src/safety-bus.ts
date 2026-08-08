/**
 * 安全总线：让「停止」在任何界面状态下都可达。
 *
 * 各模块把自己的急停函数注册进来，外壳（或任何编排层）就能在一个地方停掉**全部**
 * 已注册的设备会话，不必知道有哪些模块、它们各自怎么实现急停。
 *
 * 为什么需要：模块被切走后会被隐藏（保持挂载以免断开 BLE），此时它自己的停止按钮
 * 用户点不到，但它的设备**仍在输出**。外壳必须有一个不随模块显隐而消失的停止锚点。
 *
 * 设计上的三条约束：
 * 1. `stopAll` 必须尽最大努力停掉每一个，**不能因为某个抛错就中断**——某个模块的
 *    BLE 已断开而抛错时，其余模块的设备还在输出。
 * 2. 注册表用 Map 而不是数组：模块热重载/重新挂载时按 id 覆盖，不会堆积陈旧闭包，
 *    否则 stopAll 会去调用已卸载模块的旧函数。
 * 3. 不做「记住上次谁在输出」这类优化。停止是低频高危操作，宁可多停几个空的，
 *    也不能因为状态判断失误漏停一个。
 */

/**
 * 一台已连接设备的摘要，供外壳的设备栏展示。
 *
 * 放在安全总线而不是另起一个注册表：设备栏和停止按钮是同一件事的两面——列出设备
 * 是为了让用户知道有什么在身上，而停止必须就在旁边。拆成两个注册表意味着它们可能
 * 显示不一致，而不一致的那一刻恰好是最危险的。
 */
export interface DeviceSummary {
  /** 同一模块内稳定唯一。 */
  id: string;
  /** 设备种类：郊狼 / 负鼠 / 爪印 / 灵狐。 */
  kind: string;
  /** 面向用户的名字，通常是 BLE 广播名。 */
  name: string;
  connected: boolean;
  /** 电量百分比，未知时省略。 */
  battery?: number;
  /** 当前是否有输出。用于视觉强调，**不用于决定停止按钮是否显示**。 */
  active?: boolean;
  /** 通道强度，用于设备栏上的即时读数。 */
  channels?: { label: string; value: number; max: number }[];
}

export interface SafetySession {
  /** 模块 id，用于覆盖注册与诊断。 */
  id: string;
  /** 面向用户的名字，出现在「正在输出：DG-Agent」这类提示里。 */
  label: string;
  /**
   * 该模块当前是否**持有已连接的设备**。注意不是「是否正在输出」。
   *
   * 把停止锚点的显隐绑在「正在输出」上，等于让它依赖一条随时可能出错的状态链
   * （订阅漏更新、租约刚撤销但设备还在跑）。任何一处判断失误，按钮就在最需要它的
   * 时刻消失。宁可长期显示一个可能停了空设备的按钮。
   */
  isActive: () => boolean;
  /** 把这个模块的设备输出全部归零。必须幂等——可能被重复调用。 */
  stop: () => void | Promise<void>;
  /** 本模块当前持有的设备。外壳用它渲染设备栏。 */
  devices?: () => DeviceSummary[];
  /**
   * 失去设备控制权时调用。
   *
   * **必须做三件事**：停止输出、清掉一切「按住不放」的聚合状态、拒绝后续指令。
   * 只做第一件是不够的——例如 Chat 的开火聚合在「从空到非空」的边沿抓 baseline
   * 快照，有人按住开火时被撤权，对应的 release 消息永远不会到达，强度会停在
   * baseline+加成 不回落。
   *
   * **绝不能实现成 disconnect()。** Agent 与 Voice 的客户端开了 autoReconnect，
   * 用断连来交出控制权，后台模块会在 GATT 断开事件里静默重连把设备抢回去
   * （客户端还缓存着 BluetoothDevice 引用，重连不需要用户手势），而此时新持有者
   * 以为自己独占。
   */
  onRevoke?: () => void | Promise<void>;
}

export interface StopAllResult {
  /** 尝试停止的会话数。 */
  attempted: number;
  /** 抛错的会话，含错误本身。其余已停。 */
  failed: { id: string; error: unknown }[];
}

const sessions = new Map<string, SafetySession>();
const listeners = new Set<() => void>();

/**
 * 当前持有设备控制权的模块。
 *
 * `null` 表示没有任何模块持有——例如停在首页时。这时**没有任何模块可以下指令**，
 * 但设备仍然连着，停止按钮仍然可用。这一点很重要：交出控制权不等于断开设备。
 */
let leaseHolder: string | null = null;

function notify(): void {
  for (const l of listeners) l();
}

/** 注册一个模块的设备会话。返回注销函数。 */
export function registerSafetySession(session: SafetySession): () => void {
  sessions.set(session.id, session);
  notify();
  return () => {
    // 只在还是自己时删除：模块重挂载后新会话已覆盖旧的，旧的清理函数不该把新的删掉。
    if (sessions.get(session.id) === session) {
      sessions.delete(session.id);
      notify();
    }
  };
}

/** 当前有活动设备会话的模块。 */
export function activeSafetySessions(): SafetySession[] {
  return [...sessions.values()].filter((s) => {
    try {
      return s.isActive();
    } catch {
      // 判断本身抛错时按「活动」处理——宁可多显示一个停止按钮，也不能漏掉。
      return true;
    }
  });
}

export function hasActiveSafetySession(): boolean {
  return activeSafetySessions().length > 0;
}

/**
 * 所有模块当前持有的设备，按模块归组。
 *
 * 判断本身抛错时跳过该模块而不是中断——一个模块的状态读取出问题不该让设备栏整个
 * 消失，那会连带藏掉旁边的停止按钮。
 */
export function allConnectedDevices(): {
  sessionId: string;
  label: string;
  devices: DeviceSummary[];
}[] {
  const out: { sessionId: string; label: string; devices: DeviceSummary[] }[] = [];
  for (const s of sessions.values()) {
    try {
      const devices = s.devices?.().filter((d) => d.connected) ?? [];
      if (devices.length) out.push({ sessionId: s.id, label: s.label, devices });
    } catch {
      // 跳过这一个，其余照常。
    }
  }
  return out;
}

/**
 * 停掉全部已注册会话。
 *
 * 用 allSettled 而不是 all：某个模块抛错不能中断其余模块的停止——那正是最危险的
 * 情形（一个设备断连报错，另一个还在输出）。
 */
export async function stopAllSafetySessions(): Promise<StopAllResult> {
  const list = [...sessions.values()];
  const results = await Promise.allSettled(
    // 必须包一层：stop() 若**同步**抛错，异常会在 map 里就炸出去，根本到不了
    // allSettled——那正是最危险的情形（一台设备断连报错，其余的一个都停不了）。
    // 单测 “某个会话抛错不能中断其余会话的停止” 守着这一点。
    list.map((s) => Promise.resolve().then(() => s.stop())),
  );
  const failed = results.flatMap((r, i) =>
    r.status === 'rejected' ? [{ id: list[i]!.id, error: r.reason }] : [],
  );
  return { attempted: list.length, failed };
}

/**
 * 把设备控制权交给某个模块。其余模块立刻失去控制权并被要求停止。
 *
 * 撤权是**尽最大努力**的：某个模块的 onRevoke 抛错不能中断其余模块的撤权，
 * 那正是最危险的情形（一个模块出错，另一个还在被远程控制）。
 */
export async function grantDeviceLease(moduleId: string | null): Promise<void> {
  if (leaseHolder === moduleId) return;
  const previous = leaseHolder;
  leaseHolder = moduleId;
  notify();

  if (!previous) return;
  const losing = sessions.get(previous);
  if (!losing?.onRevoke) return;
  try {
    // `try { await f() }` 已经能接住同步抛错——调用本身就在 try 里。
    // （stopAllSafetySessions 那边需要额外包一层，是因为调用发生在 `map` 内、
    //   在 allSettled 之外，那是另一回事。）
    await losing.onRevoke();
  } catch {
    // 撤权失败时至少把它停掉——控制权已经不在它手里，但设备可能还在输出。
    try {
      await losing.stop();
    } catch {
      // 两条路都失败：全局停止按钮仍然可达，那是最后一道。
    }
  }
}

/**
 * 该模块当前有没有设备控制权。
 *
 * 模块在**每一条**设备指令之前检查它，不是只在 UI 上禁用按钮——远程指令
 * （房间里其他人、AI）根本不经过 UI。
 */
export function hasDeviceLease(moduleId: string): boolean {
  return leaseHolder === moduleId;
}

export function currentDeviceLease(): string | null {
  return leaseHolder;
}

/** 订阅注册表变化（模块挂载/卸载、控制权转移）。 */
export function subscribeSafetySessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
