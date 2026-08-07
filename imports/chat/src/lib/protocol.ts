// P2P 消息协议类型定义。
// 公共类型（UI 使用）保持长字段名；wire 格式（在 use-peer-room 内部）使用短键以减小 payload。

import type { DeviceKind } from '@dg-kit/core';

// 重新导出，供组件（SensorCard/OpossumControl/LedColorPicker 等）引用同一份枚举，
// 避免各处各自 import '@dg-kit/core'。注意：这是 BLE 设备种类枚举本身（房间协议
// 用它做 "这条指令是发给哪个设备" 的路由 discriminator），不是新的房间协议概念。
export type { DeviceKind };

/** 聊天消息附带的媒体（图片/语音）。实体存 R2，这里持已解析的可直接访问 URL。 */
export interface ChatMedia {
  kind: 'image' | 'audio';
  /** `/api/media/:code/:id` 解析后的可访问地址。 */
  url: string;
  mime: string;
  /** 语音时长（毫秒）。 */
  durationMs?: number;
  /** 图片像素宽高。 */
  w?: number;
  h?: number;
}

/** 消息中 @ 提及的成员。 */
export interface ChatMention {
  peerId: string;
  displayName: string;
}

export interface ChatMessage {
  id: string;
  fromSelf: boolean;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  media?: ChatMedia;
  /** @ 提及的成员列表（用于高亮 + 提示）。 */
  mentions?: ChatMention[];
  /** 发送者当时的角色头衔（场景扮演时）。 */
  senderRole?: string;
}

export type CmdAction =
  | 'adjust_strength'  // v=signed delta；owner 端 prev+delta 累加并 clamp 到 [0, limit]，多控制者安全
  | 'change_wave'
  | 'start'
  | 'stop'
  | 'stop_wave'
  | 'burst'
  | 'vibrate'
  | 'alert'
  | 'bg'
  | 'shake'
  | 'beep'
  | 'set_queue'
  | 'set_play_mode'
  | 'set_interval'
  | 'fire_active'     // 心跳：控制者按住期间每 300ms 一次，v=boost；owner 端 800ms 没刷新即视作松开
  | 'fire_release'    // 快速松开（非必需）：控制者松开瞬间发一次，让 owner 立即回落而不必等心跳过期
  // —— 新设备家族（Opossum / 灵猫边缘 / 爪印），见 kind 字段 ——
  // 以下几个新 action 只对 Opossum 负鼠振动控制器有意义。不复用 adjust_strength /
  // burst / stop，因为那三个隐含目标是 Coyote（历史包袱），重载它们会让所有既有
  // 消费者都要多一层 kind 判断；新增独立 action 反而更简单、向后兼容成本为零。
  | 'vibrate_adjust'  // v=signed delta（同 adjust_strength 语义，但作用于 Opossum intensity）
  | 'vibrate_stop'    // 停止 Opossum 振动（c 缺省 = 两通道都归零）
  | 'vibrate_burst'   // 一次性脉冲：v=目标强度，ms=持续时间（缺省 500ms），之后自动回落
  // set_led 对 paw-prints / civet-edging / opossum 都有意义，用 kind 区分目标设备。
  | 'set_led';

export type PlayMode = 'single' | 'list' | 'random';

/**
 * 设备命令。`target` 由 topic 携带（cmd/{peerId}），不进 payload。
 * 所有参数扁平到顶层，避免双重 JSON 编解码。
 */
export interface DeviceCommand {
  action: CmdAction;
  /**
   * 目标设备种类。省略 = 历史含义 "Coyote"（向后兼容既有的
   * adjust_strength/change_wave/... 等 action，它们从不携带这个字段）。
   * vibrate_* 系列隐含指向 'opossum'，但仍显式传递以便 UI/日志无需靠 action
   * 名字反推；set_led 必须显式传递，因为同一成员可能同时接了 sensor 和
   * opossum，两者都能设灯光。
   */
  kind?: DeviceKind;
  /** channel: 'A' | 'B' */
  c?: 'A' | 'B';
  /** numeric value: adjust_strength=delta; fire_active=boost; vibrate_adjust=delta; vibrate_burst=目标强度; fire=absolute（已废弃） */
  v?: number;
  /** waveform id */
  w?: string;
  /** generic data: alert text, bg color */
  d?: string;
  /** queue: waveform id 数组（set_queue 用） */
  q?: string[];
  /** play mode（set_play_mode 用） */
  mode?: PlayMode;
  /** interval seconds（set_interval 用） */
  iv?: number;
  /** LED 颜色枚举 0-7（set_led 用；设备协议里是离散色号，不是 RGB/连续字节，见 LedColorPicker）。 */
  color?: number;
  /** 持续时间（毫秒），vibrate_burst 用；缺省 500ms。 */
  ms?: number;
}

export interface WaveformTransfer {
  /** waveform id */
  wid: string;
  /** waveform display name */
  wn: string;
  /** waveform frames [strength, frequency][] */
  fr: [number, number][];
}

export interface WaveformCatalogEntry {
  id: string;
  name: string;
  custom: boolean;
}

/** 传感器种类（paw-prints / civet-edging）。一个成员同时只接一个传感器（v1 简化）。 */
export type SensorKind = Extract<DeviceKind, 'paw-prints' | 'civet-edging'>;

/**
 * 完整 MemberState（UI 消费）。
 * Wire 上拆成 fast（每次变化即时广播，节流 200ms）和 slow（5 秒心跳兜底）两个 topic。
 */
export interface MemberState {
  peerId: string;
  displayName: string;
  deviceConnected: boolean;
  strengthA: number;
  strengthB: number;
  waveA: string | null;
  waveB: string | null;
  battery: number | null;
  waveformCatalog?: WaveformCatalogEntry[];
  // —— 队列同步新增 ——
  queueA: string[];
  queueB: string[];
  playModeA: PlayMode;
  playModeB: PlayMode;
  intervalA: number;
  intervalB: number;
  currentIndexA: number;
  currentIndexB: number;
  // —— 开火状态新增 ——
  firingA: boolean;
  firingB: boolean;
  // —— 场景扮演新增 ——
  /** 当前认领的场景角色 id（无则未认领角色）。 */
  roleId?: string;
  /** 是否为 AI 托管的伪成员（peerId 形如 "ai:&lt;roleId&gt;"）。 */
  isAi?: boolean;
  /** 该成员是否允许房间内 AI 控制其设备（opt-in）。 */
  allowAi?: boolean;
  // —— Opossum（负鼠双通道振动控制器）新增 ——
  opossumConnected?: boolean;
  opossumIntensityA?: number;
  opossumIntensityB?: number;
  opossumBattery?: number | null;
  // —— 传感器（爪印 / 灵猫边缘，二选一）新增 ——
  sensorKind?: SensorKind | null;
  sensorConnected?: boolean;
  sensorBattery?: number | null;
  /**
   * 最近一次传感器读数的可读摘要 + 原始数值（如有）+ 时间戳。仅用于房间内
   * 展示（例如 "Alice 的爪印传感器：按钮已按下"），**不**用于自动触发任何
   * 设备动作 —— 见 lib/commands.ts 里对应的 TODO 说明为什么这次先不做
   * "传感器 X 触发设备 Y" 的自动化。
   */
  sensorLastEvent?: string | null;
  sensorLastValue?: number | null;
  sensorLastEventAt?: number | null;
}

/** 场景角色定义（= 成员可认领的头衔）。 */
export interface SceneRole {
  id: string;
  name: string;
  /** 角色描述 / 人设：既展示给成员，也作为该角色交给 AI 时的人设 prompt。 */
  description?: string;
  /** 该角色是否可由 AI 扮演（Market 上传标注；房主据此显示「交给 AI」入口）。 */
  aiPlayable?: boolean;
}

/** 房间场景：世界观 + 角色 + 玩法元数据。 */
export interface Scene {
  id: string;
  name: string;
  setting: string;
  roles: SceneRole[];
  /** 建议玩家人数。 */
  playerCount?: { min?: number; max?: number };
}

/** 高频字段：强度 + 当前波形 ID。任一变化触发立即广播。 */
export interface StateFast {
  strengthA: number;
  strengthB: number;
  waveA: string | null;
  waveB: string | null;
  // —— 开火状态新增 ——
  firingA: boolean;
  firingB: boolean;
  // —— Opossum 强度（变化频繁，走 fast） ——
  opossumIntensityA?: number;
  opossumIntensityB?: number;
  // —— 传感器最近事件（按钮按下等，同样需要低延迟） ——
  sensorLastEvent?: string | null;
  sensorLastValue?: number | null;
  sensorLastEventAt?: number | null;
}

/** 低频字段：名字、设备连接、电量、波形目录。5 秒心跳。 */
export interface StateSlow {
  displayName: string;
  deviceConnected: boolean;
  battery: number | null;
  waveformCatalog?: WaveformCatalogEntry[];
  // —— 队列同步新增 ——
  queueA: string[];
  queueB: string[];
  playModeA: PlayMode;
  playModeB: PlayMode;
  intervalA: number;
  intervalB: number;
  currentIndexA: number;
  currentIndexB: number;
  /** 是否允许房间内 AI 角色控制本机设备（opt-in；默认关闭）。 */
  allowAi?: boolean;
  // —— Opossum 连接状态 / 电量（低频） ——
  opossumConnected?: boolean;
  opossumBattery?: number | null;
  // —— 传感器连接状态 / 种类 / 电量（低频） ——
  sensorKind?: SensorKind | null;
  sensorConnected?: boolean;
  sensorBattery?: number | null;
}
