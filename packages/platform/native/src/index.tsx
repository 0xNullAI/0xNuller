import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * 原生外壳（Tauri）向模块注入蓝牙能力的**单一入口**。
 *
 * 安卓上 Web Bluetooth 不可用，必须走 plugin-blec。合并前这条缝在三个壳里形状各不
 * 相同——Agent 用 `servicesOverrides` + `connectDeviceTauri`，Chat 用
 * `deviceClientFactory` + `requestDeviceTauri`，Voice 用 `transport`。
 *
 * **三条缝的形状原样保留，只是注入点合并成一个。** 不去重塑它们是刻意的：安卓没有
 * 热更新，注入接口改错会让三个模块同时哑掉，而坏掉的版本会长期留在用户手机上。
 * 形状统一是收益很小、风险很大的一步，等真机验证过若干版之后再说。
 *
 * 用 context 而不是继续透传 props：外壳按路由懒加载模块，props 要一层层穿过
 * ModuleSlot / Suspense / ErrorBoundary，每加一个模块都要改一次外壳。
 *
 * 每一项都是可选的：拿不到就回落网页实现，而不是抛错。
 */

export interface NativeBridge {
  /** Agent 的注入：服务覆盖 + 统一连接流程。形状见 apps/agent AppProps。 */
  agent?: {
    servicesOverrides?: unknown;
    connectDevice?: unknown;
  };
  /** Chat 的注入：客户端工厂 + 设备选择器。 */
  chat?: {
    deviceClientFactory?: unknown;
    requestDevice?: unknown;
  };
  /** Voice 的注入：整套 transport。 */
  voice?: {
    transport?: unknown;
  };
}

const Ctx = createContext<NativeBridge | null>(null);

export function NativeBridgeProvider({
  bridge,
  children,
}: {
  bridge: NativeBridge;
  children: ReactNode;
}) {
  return <Ctx.Provider value={bridge}>{children}</Ctx.Provider>;
}

/** 拿到原生能力。网页端返回空对象——调用方一律按「可选」处理。 */
export function useNativeBridge(): NativeBridge {
  return useContext(Ctx) ?? EMPTY;
}

const EMPTY: NativeBridge = {};

/**
 * 是否运行在原生外壳里。
 *
 * 用于文案差异，例如设置面板里的「移动端始终停止输出，不受此项影响」——安卓的
 * 生命周期安全是无条件的，刻意覆盖用户设置。
 */
export function useIsNative(): boolean {
  return useContext(Ctx) !== null;
}
