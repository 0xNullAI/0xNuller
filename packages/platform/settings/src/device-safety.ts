import type { BrowserPermissionMode } from '@0xnullai/permissions';

/**
 * 全应用共享的设备安全设置。
 *
 * 合并前三个模块各有一套，形态与命名都不同：
 * - Agent：23 项扁平字段，存在 `dg-agent.browser-settings` 一个大 blob 里
 * - Voice：13 项嵌套在 `coyoteSafety` / `opossumSafety` 下，其中 7 项没有 UI
 * - Chat：三个裸 localStorage 字符串键，且完全没有策略引擎
 *
 * 同一个概念在两边叫不同名字（`maxAdjustStrengthStep` vs `coyoteSafety.maxAdjustStep`、
 * `maxOpossumIntensityA` vs `opossumSafety.maxIntensityA`），默认值倒是一致——说明它们
 * 本来就是同一件事，只是被复制了两次。
 *
 * 字段名采用 `@dg-kit/safety` 的 `DefaultPolicyOptions` 那套，因为策略引擎才是这些
 * 数值真正生效的地方，让存储去迁就执行方而不是反过来。
 *
 * **设备切换应用时安全设置不变。** 这是这个包存在的首要理由：用户在 Agent 里把上限
 * 调到 30，切到 Chat 不该变回 50。
 */

export interface DeviceSafetySettings {
  // ── 郊狼 ──
  maxStrengthA: number;
  maxStrengthB: number;
  maxColdStartStrength: number;
  maxAdjustStep: number;
  maxBurstDurationMs: number;
  /** 0 表示不启用这条额外约束。 */
  maxBurstStrengthAbsolute: number;
  /** 0 表示不启用这条额外约束。 */
  maxBurstStrengthRelative: number;
  burstRequiresActiveChannel: boolean;

  // ── 负鼠 ──
  maxIntensityA: number;
  maxIntensityB: number;
  maxColdStartIntensity: number;
  maxOpossumAdjustStep: number;

  // ── 单回合调用上限（AI 驱动时才有意义，但归属设备安全）──
  maxToolIterations: number;
  maxToolCallsPerTurn: number;
  maxAdjustStrengthCallsPerTurn: number;
  maxBurstCallsPerTurn: number;
  maxVibrateAdjustCallsPerTurn: number;
  maxVibrateBurstCallsPerTurn: number;

  // ── 权限与生命周期 ──
  permissionMode: BrowserPermissionMode;
  /** `timed` 模式的到期时间戳。 */
  permissionModeExpiresAt?: number;
  /** 切到后台时是否自动停止输出。 */
  backgroundBehavior: 'stop' | 'keep';
}

export const DEFAULT_DEVICE_SAFETY: DeviceSafetySettings = {
  maxStrengthA: 50,
  maxStrengthB: 50,
  maxColdStartStrength: 10,
  maxAdjustStep: 10,
  maxBurstDurationMs: 5_000,
  maxBurstStrengthAbsolute: 0,
  maxBurstStrengthRelative: 0,
  burstRequiresActiveChannel: true,

  maxIntensityA: 50,
  maxIntensityB: 50,
  maxColdStartIntensity: 10,
  maxOpossumAdjustStep: 10,

  maxToolIterations: 8,
  maxToolCallsPerTurn: 12,
  maxAdjustStrengthCallsPerTurn: 4,
  maxBurstCallsPerTurn: 2,
  maxVibrateAdjustCallsPerTurn: 4,
  maxVibrateBurstCallsPerTurn: 2,

  permissionMode: 'confirm',
  backgroundBehavior: 'stop',
};

const KEY = '0xnullai.device-safety';

/**
 * `allow-all` 不过夜。
 *
 * Agent 的语义：完全放行只在本次会话有效，落盘时降级为 `confirm`。Voice 原本是永久
 * 落盘——刷新后仍然完全放行。采用严格的那一套，否则「危险模式不过夜」这条保护会在
 * 合并中静默消失。
 */
function persistableMode(mode: BrowserPermissionMode): BrowserPermissionMode {
  return mode === 'allow-all' ? 'confirm' : mode;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function coerce(raw: unknown): DeviceSafetySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DEVICE_SAFETY };
  const o = raw as Record<string, unknown>;
  const out = { ...DEFAULT_DEVICE_SAFETY };
  for (const key of Object.keys(DEFAULT_DEVICE_SAFETY) as (keyof DeviceSafetySettings)[]) {
    const fallback = DEFAULT_DEVICE_SAFETY[key];
    if (typeof fallback === 'number') {
      (out[key] as number) = num(o[key], fallback);
    } else if (typeof fallback === 'boolean') {
      (out[key] as boolean) = typeof o[key] === 'boolean' ? (o[key] as boolean) : fallback;
    }
  }
  const mode = o.permissionMode;
  out.permissionMode =
    mode === 'confirm' || mode === 'timed' || mode === 'allow-all'
      ? persistableMode(mode as BrowserPermissionMode)
      : 'confirm';
  if (typeof o.permissionModeExpiresAt === 'number') {
    out.permissionModeExpiresAt = o.permissionModeExpiresAt;
  }
  out.backgroundBehavior = o.backgroundBehavior === 'keep' ? 'keep' : 'stop';
  return out;
}

/**
 * 合并前三处存量到规范字段名的映射。
 *
 * 值得单独说明的两处改名：Agent 的 `maxAdjustStrengthStep` 与 Voice 的
 * `coyoteSafety.maxAdjustStep` 是同一件事；Agent 的 `maxOpossumIntensityA` 与 Voice 的
 * `opossumSafety.maxIntensityA` 也是。迁移时漏掉任何一条，用户调过的上限会静默回到
 * 默认值——这个方向的失败很难被发现，因为默认值本身是合理的。
 */
function migrate(): DeviceSafetySettings | null {
  const out = { ...DEFAULT_DEVICE_SAFETY };
  let found = false;

  try {
    const agent = JSON.parse(localStorage.getItem('dg-agent.browser-settings') ?? 'null') as Record<
      string,
      unknown
    > | null;
    if (agent) {
      found = true;
      out.maxStrengthA = num(agent.maxStrengthA, out.maxStrengthA);
      out.maxStrengthB = num(agent.maxStrengthB, out.maxStrengthB);
      out.maxColdStartStrength = num(agent.maxColdStartStrength, out.maxColdStartStrength);
      out.maxAdjustStep = num(agent.maxAdjustStrengthStep, out.maxAdjustStep);
      out.maxBurstDurationMs = num(agent.maxBurstDurationMs, out.maxBurstDurationMs);
      out.maxBurstStrengthAbsolute = num(
        agent.maxBurstStrengthAbsolute,
        out.maxBurstStrengthAbsolute,
      );
      out.maxBurstStrengthRelative = num(
        agent.maxBurstStrengthRelative,
        out.maxBurstStrengthRelative,
      );
      if (typeof agent.burstRequiresActiveChannel === 'boolean') {
        out.burstRequiresActiveChannel = agent.burstRequiresActiveChannel;
      }
      out.maxIntensityA = num(agent.maxOpossumIntensityA, out.maxIntensityA);
      out.maxIntensityB = num(agent.maxOpossumIntensityB, out.maxIntensityB);
      out.maxColdStartIntensity = num(
        agent.maxOpossumColdStartIntensity,
        out.maxColdStartIntensity,
      );
      out.maxOpossumAdjustStep = num(agent.maxOpossumAdjustStep, out.maxOpossumAdjustStep);
      out.maxToolIterations = num(agent.maxToolIterations, out.maxToolIterations);
      out.maxToolCallsPerTurn = num(agent.maxToolCallsPerTurn, out.maxToolCallsPerTurn);
      out.maxAdjustStrengthCallsPerTurn = num(
        agent.maxAdjustStrengthCallsPerTurn,
        out.maxAdjustStrengthCallsPerTurn,
      );
      out.maxBurstCallsPerTurn = num(agent.maxBurstCallsPerTurn, out.maxBurstCallsPerTurn);
      out.maxVibrateAdjustCallsPerTurn = num(
        agent.maxVibrateAdjustCallsPerTurn,
        out.maxVibrateAdjustCallsPerTurn,
      );
      out.maxVibrateBurstCallsPerTurn = num(
        agent.maxVibrateBurstCallsPerTurn,
        out.maxVibrateBurstCallsPerTurn,
      );
      if (typeof agent.permissionMode === 'string') {
        out.permissionMode = persistableMode(agent.permissionMode as BrowserPermissionMode);
      }
      if (agent.backgroundBehavior === 'keep') out.backgroundBehavior = 'keep';
    }
  } catch {
    // Agent 的 blob 坏了不影响其它来源。
  }

  try {
    const voice = JSON.parse(localStorage.getItem('dg-voice-settings') ?? 'null') as Record<
      string,
      unknown
    > | null;
    const coyote = voice?.coyoteSafety as Record<string, unknown> | undefined;
    const opossum = voice?.opossumSafety as Record<string, unknown> | undefined;
    if (coyote || opossum) {
      found = true;
      // Agent 已经写过的值不被 Voice 覆盖——两边都调过时取先到者，避免「以为改的是
      // 这个模块的设置，结果被另一个模块的旧值顶掉」。
      if (coyote) {
        out.maxBurstDurationMs = num(coyote.maxBurstDurationMs, out.maxBurstDurationMs);
        out.maxBurstStrengthAbsolute = num(
          coyote.maxBurstStrengthAbsolute,
          out.maxBurstStrengthAbsolute,
        );
        out.maxBurstStrengthRelative = num(
          coyote.maxBurstStrengthRelative,
          out.maxBurstStrengthRelative,
        );
      }
      if (opossum) {
        out.maxColdStartIntensity = num(opossum.maxColdStartIntensity, out.maxColdStartIntensity);
        out.maxOpossumAdjustStep = num(opossum.maxAdjustStep, out.maxOpossumAdjustStep);
      }
    }
  } catch {
    // 同上。
  }

  try {
    const bg = localStorage.getItem('dg-bg-behavior');
    if (bg === 'keep' || bg === 'stop') {
      found = true;
      out.backgroundBehavior = bg;
    }
  } catch {
    // 同上。
  }

  return found ? out : null;
}

const listeners = new Set<(s: DeviceSafetySettings) => void>();

export function loadDeviceSafety(): DeviceSafetySettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_DEVICE_SAFETY };
  try {
    const own = localStorage.getItem(KEY);
    if (own) return coerce(JSON.parse(own));
    const migrated = migrate();
    if (migrated) {
      saveDeviceSafety(migrated);
      return migrated;
    }
  } catch {
    // 存储被污染时回落默认值——默认值是最保守的那一组，这个方向的失败是安全的。
  }
  return { ...DEFAULT_DEVICE_SAFETY };
}

export function saveDeviceSafety(next: DeviceSafetySettings): DeviceSafetySettings {
  const persisted: DeviceSafetySettings = {
    ...next,
    permissionMode: persistableMode(next.permissionMode),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(persisted));
  } catch {
    // 存不下时本次会话内仍然生效。
  }
  for (const l of listeners) l(next);
  return next;
}

export function updateDeviceSafety(
  updater: (prev: DeviceSafetySettings) => DeviceSafetySettings,
): DeviceSafetySettings {
  return saveDeviceSafety(updater(loadDeviceSafety()));
}

export function subscribeDeviceSafety(listener: (s: DeviceSafetySettings) => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener(loadDeviceSafety());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * 当前**生效**的权限模式。
 *
 * `timed` 到期后自动回落 `confirm`。这个判断必须在读取时做，不能只在写入时做——
 * 用户可能开着页面过了五分钟。
 */
export function effectivePermissionMode(s: DeviceSafetySettings): BrowserPermissionMode {
  if (s.permissionMode !== 'timed') return s.permissionMode;
  if (!s.permissionModeExpiresAt || Date.now() > s.permissionModeExpiresAt) return 'confirm';
  return 'timed';
}
