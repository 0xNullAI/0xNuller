/**
 * 安全确认的接受状态。
 *
 * **全系统一份。** 合并前 Agent 与 Chat 各自把门设在自己的入口，各自记各自的状态，
 * 于是在统一外壳里同一份协议要被确认两次。现在协议只有一份（见
 * `safety-notice-content.ts`），接受状态自然也只该有一份——进主界面时确认一次，
 * 之后所有模块都算已确认。
 *
 * 门本身没有被削弱：默认是「显示」，只有用户明确勾了「不再弹出」才会被记住。
 * 没勾就是本次会话有效，下次启动照样弹。
 */

const KEY = '0xnullai.safety-accepted';
/** 合并前各模块自己的键，用于一次性迁移。 */
const LEGACY_KEYS = ['dg-chat-safety-accepted'];

/**
 * 用户是否已经永久接受过。
 *
 * 读不到存储时返回 false——**必须是 false**。隐私模式或存储异常时宁可多弹一次，
 * 也不能因为读不到就默认放行。
 */
export function isSafetyNoticeAccepted(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    if (localStorage.getItem(KEY) === 'true') return true;
    for (const legacy of LEGACY_KEYS) {
      if (localStorage.getItem(legacy) === 'true') {
        localStorage.setItem(KEY, 'true');
        return true;
      }
    }
  } catch {
    // 读不到就当没接受过。
  }
  return false;
}

/** 记住「不再弹出」。只有用户明确勾选时才该调用。 */
export function rememberSafetyNoticeAccepted(): void {
  try {
    localStorage.setItem(KEY, 'true');
  } catch {
    // 存不下就下次再弹一遍——这个方向的失败是安全的。
  }
}

/** 让确认重新生效（设置里的「重新显示安全确认」）。 */
export function forgetSafetyNoticeAccepted(): void {
  try {
    localStorage.removeItem(KEY);
    for (const legacy of LEGACY_KEYS) localStorage.removeItem(legacy);
  } catch {
    // 忽略：清不掉时用户还可以清站点数据。
  }
}
