// DG-Chat WebSocket wire 协议。
// 原 MQTT 用 topic 区分消息类型，现折叠进单条 WS 消息的 `t` 字段，由 RoomDO 路由。
// 该文件为纯类型 + 常量，无运行时依赖，可被 Worker 与（参照）前端共用。

/** 房间内消息类型。 */
export type WireType =
  | 'hello' // client→DO，加入首帧：声明昵称 / 是否公开 / 房间名
  | 'chat' // 聊天消息（持久化进历史，含可选 media 引用）
  | 'sf' // state.fast：强度/波形/开火，广播
  | 'ss' // state.slow：名字/电量/队列/目录，广播
  | 'presence' // 昵称心跳（轻量，广播）
  | 'cmd' // 设备命令，定向（to=peerId）
  | 'wave' // 波形传输，定向（to=peerId）
  | 'leave' // 主动离开
  | 'scene' // 场景：房主设/改（client→DO）；当前场景+host 广播（DO→client）
  | 'role' // 角色：认领/释放（client→DO）；角色→peer 分配广播（DO→client）
  | 'history' // DO→client：新人加入回放
  | 'sys'; // DO→client：连接级 presence（joined/left）

/** 媒体引用（图片/语音）。实体存 R2，消息只带引用。 */
export interface MediaRef {
  kind: 'image' | 'audio';
  /** R2 object id（不含房间前缀与扩展名由 mime 推断）。 */
  id: string;
  mime: string;
  size: number;
  /** 语音时长（毫秒），图片可带宽高。 */
  durationMs?: number;
  w?: number;
  h?: number;
}

/** 持久化的聊天消息（DO SQLite 行 ↔ history 回放 ↔ chat 广播体）。
 *  注意：`t` 是信封的消息类型（'chat'），时间戳用 `ts`，二者不可混用。 */
export interface WireChat {
  /** 消息类型标记（广播体里恒为 'chat'）。 */
  t?: 'chat';
  id: string;
  /** 发送者 peerId（DO 注入，可信）。 */
  _from?: string;
  /** 发送者昵称快照。 */
  n: string;
  /** 文本正文（媒体消息可为空）。 */
  x?: string;
  /** 媒体引用。 */
  m?: MediaRef;
  /** @ 提及的成员（peerId + 昵称快照）。 */
  mentions?: { peerId: string; n: string }[];
  /** 发送者当时的角色头衔快照（无则普通成员）。 */
  senderRole?: string;
  /** 发送时间戳（毫秒）。 */
  ts: number;
}

/** 场景角色定义。 */
export interface SceneRole {
  id: string;
  /** 角色名（= 成员头衔）。 */
  name: string;
  /** 角色描述 / 人设：既展示给成员，也作为该角色交给 AI 时的人设 prompt。 */
  description?: string;
  /** 该角色是否可由 AI 扮演（场景上传时标注；房主据此显示「交给 AI」入口）。 */
  aiPlayable?: boolean;
}

/** 房间场景（世界观 + 角色 + 玩法元数据）。 */
export interface Scene {
  id: string;
  name: string;
  /** 世界观/背景描述。 */
  setting: string;
  roles: SceneRole[];
  /** 建议玩家人数（Market 上传时填，房间可选展示）。 */
  playerCount?: { min?: number; max?: number };
}

/** DO→client：当前场景 + 房主。scene 为 null 表示未设场景。 */
export interface WireScene {
  t: 'scene';
  scene: Scene | null;
  host: string; // hostPeerId
}

/** DO→client：角色→peer 的认领分配（权威态）。 */
export interface WireRole {
  t: 'role';
  assignments: Record<string, string>; // roleId -> peerId
}

/** 客户端发往 DO 的信封（除 hello 外，业务字段扁平在顶层）。 */
export interface WireInbound {
  t: WireType;
  /** 定向消息的目标 peerId（cmd/wave）。 */
  to?: string;
  /** 任意业务字段（chat 的 x/m、sf/ss 的状态字段、cmd 的 a/c/v…）。 */
  [k: string]: unknown;
}

/** DO 发往客户端的 sys 帧。 */
export interface WireSys {
  t: 'sys';
  kind: 'joined' | 'left';
  peerId: string;
}

/** DO 发往客户端的 history 帧。 */
export interface WireHistory {
  t: 'history';
  messages: WireChat[];
}

/** 单例大厅 DO 的固定名字。 */
export const LOBBY_NAME = 'v1';

/** 房间空置后清理的宽限期（毫秒）。 */
export const ROOM_GRACE_MS = 10 * 60 * 1000;

/** 大厅常驻的官方公开讨论房：始终公开、永不清理、空房也显示在大厅顶部。 */
export const RESERVED_ROOM_CODE = '0xNullAI';
export const RESERVED_ROOM_NAME = '0xNullAI 公开讨论区';

/** 上传媒体大小上限（字节）。 */
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/** 允许的媒体 MIME 前缀。 */
export const ALLOWED_MEDIA_PREFIXES = ['image/', 'audio/'];
