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

export interface SafetySession {
  /** 模块 id，用于覆盖注册与诊断。 */
  id: string;
  /** 面向用户的名字，出现在「正在输出：DG-Agent」这类提示里。 */
  label: string;
  /** 该模块当前是否有活动的设备会话。用于决定外壳要不要显示停止锚点。 */
  isActive: () => boolean;
  /** 把这个模块的设备输出全部归零。必须幂等——可能被重复调用。 */
  stop: () => void | Promise<void>;
}

export interface StopAllResult {
  /** 尝试停止的会话数。 */
  attempted: number;
  /** 抛错的会话，含错误本身。其余已停。 */
  failed: { id: string; error: unknown }[];
}

const sessions = new Map<string, SafetySession>();
const listeners = new Set<() => void>();

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

/** 订阅注册表变化（模块挂载/卸载）。用于外壳刷新停止锚点的显隐。 */
export function subscribeSafetySessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
