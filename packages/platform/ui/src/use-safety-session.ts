import { useEffect, useRef } from 'react';
import { registerSafetySession, type DeviceSummary } from '@dg-kit/safety';

/**
 * 把一个模块的设备会话注册到全局安全总线。
 *
 * **这是全局停止按钮能否出现的唯一来源。** 在此之前 `registerSafetySession` 全仓零调用
 * 方，`EmergencyStopButton` 因此永远走 `return null`——那个按钮从未渲染过，而构建、
 * 测试、lint 全绿。教训是：验证「切走模块后按钮还在」之前，得先验证它出现过。
 *
 * `isActive` 的语义是**「本模块是否持有已连接的设备」**，不是「是否正在输出」。
 * 这一条是刻意的：把停止按钮的显隐绑在「正在输出」上，意味着任何一处状态判断出错
 * （订阅漏更新、刚撤销租约但设备还在跑）都会让按钮消失。宁可长期显示一个可能停了
 * 空设备的按钮，也不能有一刻它该在却不在。
 */

export interface SafetySessionSpec {
  id: string;
  label: string;
  /** 本模块当前是否持有已连接的设备。 */
  isActive: () => boolean;
  /** 把本模块的设备输出全部归零。必须幂等。 */
  stop: () => void | Promise<void>;
  /** 本模块当前持有的设备，供外壳的设备栏展示。 */
  devices?: () => DeviceSummary[];
}

export function useSafetySession(spec: SafetySessionSpec): void {
  // 回调存 ref：注册只在 id 变化时发生一次，但 stop/isActive 每次渲染都是新函数。
  // 直接把它们放进依赖数组会导致每帧重新注册，Map 里塞的是随时过期的闭包。
  const latest = useRef(spec);
  latest.current = spec;

  useEffect(() => {
    return registerSafetySession({
      id: spec.id,
      label: spec.label,
      isActive: () => latest.current.isActive(),
      stop: () => latest.current.stop(),
      devices: () => latest.current.devices?.() ?? [],
    });
  }, [spec.id, spec.label]);
}
