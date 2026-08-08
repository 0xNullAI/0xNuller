import React from 'react';
import ReactDOM from 'react-dom/client';
import { Shell } from '@0xnullai/web/Shell';
import { NativeBridgeProvider } from '@0xnullai/native';
import {
  TauriBlecDeviceClient,
  TauriBlecOpossumClient,
  TauriBlecPawPrintsClient,
  TauriBlecCivetEdgingClient,
} from '@dg-kit/transport-tauri-blec';
import { showDevicePicker } from './components/show-device-picker';
import { UpdateBanner } from './components/UpdateBanner';
import { connectAnyDgLabDeviceTauri } from './connect-any-device-tauri';
import { requestDeviceTauri } from './request-device-tauri';
import { createTauriTransport } from './tauri-transport';
import { wrapWithLifecycleSafety } from './lifecycle-safety';
import { installAndroidShellBehaviours, withBlePermissionHelp } from './android-shell';
import './styles.css';

/**
 * 统一的安卓应用：一个 APK，四个模块。
 *
 * 合并前是三个各自打包的 APK（Agent / Chat / Voice），用户要装三个、各连一次设备、
 * 各配一遍设置。现在它们是同一个外壳里的四个模块，共享设备、安全设置、场景库与账号。
 *
 * **安卓没有热更新。** 这里出的任何错都会长期留在用户手机上，所以三条原生注入缝的
 * 形状原样保留（见 @0xnullai/native 的注释），只是注入点合并成一个。
 */

installAndroidShellBehaviours();

// React 提交首帧后淡出 index.html 里的启动图。
queueMicrotask(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('nx-splash');
    if (splash) {
      splash.classList.add('nx-splash-loaded');
      setTimeout(() => splash.remove(), 250);
    }
  });
});

// Vite 构建时内联。安卓请求没有浏览器 Origin，免费代理靠这个签名区分「是我们的
// 客户端」与「任何人」。
const freeProxySecret = import.meta.env.VITE_DG_PROXY_SECRET;

/**
 * 就地把 `connect()` 包上权限提示，返回同一个实例。
 *
 * **刻意不用 `{ ...inner, connect }`**：这里的 inner 是类实例，而类体里声明的方法住在
 * 原型上不是实例上。展开只会拷走自有可枚举属性，disconnect/getState/execute 全部丢失，
 * 于是除了 connect 之外任何调用都抛 "is not a function"。
 */
function withConnectPermissionHelp<T extends { connect(): Promise<void> }>(inner: T): T {
  const rawConnect = inner.connect.bind(inner);
  inner.connect = () => withBlePermissionHelp(rawConnect);
  return inner;
}

const bridge = {
  agent: {
    servicesOverrides: {
      disableSpeech: true,
      disableBridge: true,
      disableUpdateChecker: true,
      freeProxySecret,
      createDeviceClient: (
        protocol: ConstructorParameters<typeof TauriBlecDeviceClient>[0]['protocol'],
      ) => {
        const inner = wrapWithLifecycleSafety(
          new TauriBlecDeviceClient({
            protocol,
            selectDevice: showDevicePicker,
            namePrefixes: ['47L121', 'D-LAB'],
            scanDurationMs: 8000,
          }),
        );
        // 用户拒绝蓝牙权限时给一个能看懂的提示。内层客户端抛的是「未授予蓝牙权限」，
        // 不包一层就只是一条小提示，用户不知道该做什么。
        return { ...inner, connect: () => withBlePermissionHelp(() => inner.connect()) };
      },
      createOpossumClient: () =>
        withConnectPermissionHelp(
          new TauriBlecOpossumClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
        ),
      createPawPrintsClient: () =>
        withConnectPermissionHelp(
          new TauriBlecPawPrintsClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
        ),
      createCivetEdgingClient: () =>
        withConnectPermissionHelp(
          new TauriBlecCivetEdgingClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
        ),
    },
    connectDevice: (clients: unknown) =>
      withBlePermissionHelp(() => connectAnyDgLabDeviceTauri(clients as never)),
  },
  chat: {
    deviceClientFactory: (
      protocol: ConstructorParameters<typeof TauriBlecDeviceClient>[0]['protocol'],
    ) => {
      const inner = wrapWithLifecycleSafety(
        new TauriBlecDeviceClient({
          protocol,
          selectDevice: showDevicePicker,
          namePrefixes: ['47L121', 'D-LAB'],
          scanDurationMs: 8000,
        }),
      );
      return { ...inner, connect: () => withBlePermissionHelp(() => inner.connect()) };
    },
    requestDevice: () => withBlePermissionHelp(() => requestDeviceTauri()),
  },
  voice: {
    transport: createTauriTransport(),
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <UpdateBanner />
    <NativeBridgeProvider bridge={bridge}>
      <Shell />
    </NativeBridgeProvider>
  </React.StrictMode>,
);
