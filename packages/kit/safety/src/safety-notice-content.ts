/**
 * Body text of the pre-use safety acknowledgement.
 *
 * Lives in kit/safety rather than the UI layer because it is part of the
 * safety chain: it is the product's risk disclosure to the user, and whoever
 * audits that will look in this package first. The UI layer only decides how
 * to display it.
 *
 * Before the merge, Agent and Chat each carried a copy; seven of the nine
 * items were byte-identical and the other two had already silently diverged —
 * Agent's "do not use / use with caution" section had "or consult a
 * professional first", Chat's did not. That is exactly what "safety logic
 * must never have a second independently-evolving copy" is meant to prevent:
 * nobody remembers to update both.
 *
 * Think before editing this copy: these sentences exist to keep people from
 * getting hurt; they are not marketing text.
 */

export interface SafetyNoticeSection {
  title: string;
  items: readonly string[];
}

export const SAFETY_NOTICE_SECTIONS: readonly SafetyNoticeSection[] = [
  {
    title: '开始前确认',
    items: [
      '本项目会驱动设备输出波形，浏览器、蓝牙、网络与桥接链路都可能出现异常或延迟。',
      '使用时请保持清醒，并确保你可以随时通过物理方式断开设备或停止输出。',
      '本项目不是医疗产品，也不能替代专业判断或风险评估。',
    ],
  },
  {
    title: '禁用与慎用',
    items: [
      // When merging the two copies, keep the more complete sentence: Chat's
      // version was missing the "or consult a professional first" escape.
      '心脏起搏器、心血管疾病、癫痫、孕期或任何不确定身体状况时，请不要使用，或先咨询专业人士。',
      '禁止将电极放在胸口、头部、颈部、破损皮肤、炎症区域或任何异常敏感部位。',
      '独处、睡眠、洗澡、饮酒后、驾驶中或操作机械时，禁止使用。',
    ],
  },
  {
    title: '使用中要求',
    items: [
      '首次使用或更换部位时，请从最低强度开始，逐步确认体感与安全边界。',
      '输出期间不要移动电极，不要频繁切换贴片位置，也不要让导电部件短接。',
      '若出现刺痛、灼热、头晕、心悸或任何不适，请立刻停止并断开设备。',
    ],
  },
] as const;

export interface SafetyCallout {
  title: string;
  body: string;
}

/**
 * The single most important callout at the top. Risk sources differ per
 * module, hence the per-module keys — but the body lives here once; modules
 * are not allowed to write their own.
 */
export const SAFETY_CALLOUTS: Record<string, SafetyCallout> = {
  agent: {
    title: 'AI 不是安全控制器。',
    body: '模型可能误判，浏览器、蓝牙或桥接链路也可能卡顿、重试、断连或产生非预期行为。请始终把“立刻停止输出”和“立刻断开设备”放在最高优先级。',
  },
  chat: {
    title: '远程控制具有不确定性。',
    body: '房间里的其他人、浏览器、蓝牙或网络链路都可能产生非预期行为。请始终把“立刻停止输出”和“立刻断开设备”放在最高优先级。',
  },
  voice: {
    title: '语音识别会出错。',
    body: '模型可能听错或误判，网络链路也可能卡顿、断连。请始终把“立刻停止输出”和“立刻断开设备”放在最高优先级。',
  },
};

export const DEFAULT_SAFETY_CALLOUT: SafetyCallout = {
  title: '设备输出具有不确定性。',
  body: '浏览器、蓝牙或网络链路可能卡顿、断连或产生非预期行为。请始终把“立刻停止输出”和“立刻断开设备”放在最高优先级。',
};

/** Forced reading time in seconds. The button is unclickable until it elapses. */
export const SAFETY_NOTICE_COUNTDOWN_SECONDS = 10;
