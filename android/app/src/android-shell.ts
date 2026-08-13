/**
 * Android-only behaviours that go on top of the React app.
 *
 * Web doesn't need any of this (no system status bar, no Android back
 * button, native browsers handle keyboard reflow themselves).
 *
 * Call `installAndroidShellBehaviours()` once at app start, before render.
 */

import { getAdapterState, type AdapterState } from '@mnlphlp/plugin-blec';

const DARK_BG = '#0b1020';
const LIGHT_BG = '#ffffff';

/**
 * Keep `<meta name="theme-color">` in sync with `<html data-theme="...">`.
 * Status-bar tint on Android Tauri reads from theme-color; without this
 * the status bar stays dark even after the user switches to light mode.
 */
function syncStatusBarColor(): void {
  const apply = () => {
    const theme = document.documentElement.getAttribute('data-theme') ?? 'dark';
    const colour = theme === 'light' ? LIGHT_BG : DARK_BG;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = colour;
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

/**
 * When a text input gains focus, scroll it into view above the soft
 * keyboard. Android WebView usually does this itself but is unreliable
 * inside flex / dvh layouts (the chat input is at the bottom of a
 * 100dvh flex column — WebView's auto-scroll lands too high).
 *
 * The delay lets the visualViewport shrink first; scrollIntoView then
 * targets the post-keyboard layout.
 */
function autoScrollFocusedInput(): void {
  const handler = (event: FocusEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (
      target.tagName !== 'INPUT' &&
      target.tagName !== 'TEXTAREA' &&
      target.contentEditable !== 'true'
    ) {
      return;
    }
    setTimeout(() => {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 250);
  };
  document.addEventListener('focusin', handler);
}

/** Drive the shell from visualViewport, the only viewport Android shrinks for IME. */
export function syncVisualViewport(viewport = window.visualViewport): () => void {
  if (!viewport) return () => undefined;
  const apply = () => {
    const height = Math.round(viewport.height);
    const keyboardInset = Math.max(
      0,
      Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
    );
    document.documentElement.style.setProperty('--android-viewport-height', `${height}px`);
    document.documentElement.style.setProperty('--android-keyboard-inset', `${keyboardInset}px`);
    document.documentElement.toggleAttribute('data-keyboard-open', keyboardInset > 80);
  };
  apply();
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
  return () => {
    viewport.removeEventListener('resize', apply);
    viewport.removeEventListener('scroll', apply);
  };
}

/**
 * Intercept Android's hardware/gesture back button so it doesn't exit
 * the app on the first press. Tauri Android maps the back button to
 * the WebView's history-back; we push a synthetic state on every app
 * load so the first back press pops that state instead of leaving.
 *
 * Apps that want to react to back press should listen for
 * `window.addEventListener('app:back', ...)`. The default handler shows
 * a "再按一次退出" toast — second press within 2s actually exits.
 */
function interceptBackButton(): void {
  history.pushState({ dgaa: 'guard' }, '');
  let lastBackPress = 0;
  window.addEventListener('popstate', () => {
    const detail = new CustomEvent('app:back', { cancelable: true });
    const accepted = window.dispatchEvent(detail);
    if (accepted === false) {
      // A listener consumed it (e.g. closed a modal). Re-push the guard.
      history.pushState({ dgaa: 'guard' }, '');
      return;
    }
    const now = Date.now();
    if (now - lastBackPress < 2000) {
      // User pressed back twice quickly → really exit. Pop the guard so
      // the next popstate actually closes the activity.
      return;
    }
    lastBackPress = now;
    showBackToast('再按一次退出');
    history.pushState({ dgaa: 'guard' }, '');
  });
}

function showBackToast(text: string): void {
  let toast = document.getElementById('dgaa-back-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dgaa-back-toast';
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: 'calc(48px + env(safe-area-inset-bottom))',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '10px 18px',
      background: 'rgba(20, 20, 28, 0.92)',
      color: '#f4f4f5',
      borderRadius: '999px',
      fontSize: '13px',
      zIndex: 'var(--z-native-toast)',
      pointerEvents: 'none',
      transition: 'opacity 200ms',
      opacity: '0',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  requestAnimationFrame(() => {
    toast!.style.opacity = '1';
  });
  setTimeout(() => {
    toast!.style.opacity = '0';
  }, 1500);
}

interface AndroidSystemBridge {
  getSdkInt(): number;
  isLocationEnabled(): boolean;
  isBlePermissionPermanentlyDenied(): boolean;
  hasBleScanPermission(): boolean;
  requestBleScanPermission(): void;
  openAppSettings(): void;
  openBluetoothSettings(): void;
  openLocationSettings(): void;
}

declare global {
  interface Window {
    AndroidSystem?: AndroidSystemBridge;
  }
}

export interface BlePlatform {
  getAdapterState(): Promise<AdapterState>;
  getSdkInt(): number;
  isLocationEnabled(): boolean;
  isPermissionPermanentlyDenied(): boolean;
  hasBleScanPermission(): boolean;
  requestBleScanPermission(): void;
  openAppSettings(): void;
  openBluetoothSettings(): void;
  openLocationSettings(): void;
}

function androidMajorFromUserAgent(): number | null {
  const match = /Android\s+(\d+)/i.exec(navigator.userAgent);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

const defaultBlePlatform: BlePlatform = {
  getAdapterState,
  getSdkInt: () => {
    const nativeSdk = window.AndroidSystem?.getSdkInt();
    if (nativeSdk) return nativeSdk;
    return (androidMajorFromUserAgent() ?? 12) >= 12 ? 31 : 30;
  },
  isLocationEnabled: () => window.AndroidSystem?.isLocationEnabled() ?? true,
  isPermissionPermanentlyDenied: () =>
    window.AndroidSystem?.isBlePermissionPermanentlyDenied() ?? false,
  hasBleScanPermission: () => window.AndroidSystem?.hasBleScanPermission() ?? true,
  requestBleScanPermission: () => window.AndroidSystem?.requestBleScanPermission(),
  openAppSettings: () => window.AndroidSystem?.openAppSettings(),
  openBluetoothSettings: () => window.AndroidSystem?.openBluetoothSettings(),
  openLocationSettings: () => window.AndroidSystem?.openLocationSettings(),
};

interface GuidanceAction {
  label: string;
  run(): void;
}

/** Show one Android-native guidance layer with an explicit settings action. */
export function showBleGuidance(message: string, action?: GuidanceAction): Promise<void> {
  document.getElementById('dgaa-ble-guidance')?.remove();
  const backdrop = document.createElement('div');
  backdrop.id = 'dgaa-ble-guidance';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  Object.assign(backdrop.style, {
    position: 'fixed',
    inset: '0',
    zIndex: 'var(--z-native-overlay)',
    display: 'grid',
    placeItems: 'center',
    padding: '24px',
    background: 'rgba(0, 0, 0, 0.55)',
  } satisfies Partial<CSSStyleDeclaration>);

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    width: 'min(100%, 420px)',
    border: '1px solid var(--surface-border)',
    borderRadius: 'var(--radius-md)',
    padding: '20px',
    background: 'var(--bg-elevated)',
    color: 'var(--text)',
    boxShadow: 'var(--shadow-panel)',
  } satisfies Partial<CSSStyleDeclaration>);
  const title = document.createElement('h2');
  title.textContent = '无法扫描蓝牙设备';
  Object.assign(title.style, { margin: '0 0 10px', fontSize: '18px', fontWeight: '700' });
  const body = document.createElement('p');
  body.textContent = message;
  Object.assign(body.style, { margin: '0', color: 'var(--text-soft)', lineHeight: '1.6' });
  const actions = document.createElement('div');
  Object.assign(actions.style, {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '18px',
  });

  return new Promise((resolve) => {
    const close = () => {
      backdrop.remove();
      resolve();
    };
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', close);
    Object.assign(cancel.style, {
      border: '1px solid var(--surface-border-strong)',
      borderRadius: 'var(--radius-ctl)',
      padding: '9px 14px',
      background: 'var(--bg-strong)',
    });
    actions.appendChild(cancel);

    if (action) {
      const actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.textContent = action.label;
      actionButton.addEventListener('click', () => {
        action.run();
        close();
      });
      Object.assign(actionButton.style, {
        border: '0',
        borderRadius: 'var(--radius-ctl)',
        padding: '9px 14px',
        background: 'var(--accent)',
        color: 'var(--button-text)',
        fontWeight: '600',
      });
      actions.appendChild(actionButton);
    }

    panel.append(title, body, actions);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
  });
}

/** Run shared BLE preflight and map each Android failure to a precise remedy. */
export async function withBlePermissionHelp<T>(
  connectCall: () => Promise<T>,
  platform: BlePlatform = defaultBlePlatform,
): Promise<T> {
  let adapterState: AdapterState = 'Unknown';
  try {
    adapterState = await platform.getAdapterState();
  } catch {
    // Android 12+ may require Nearby devices before adapter state is readable.
    // The underlying connect call requests that permission next.
  }
  if (adapterState === 'Off') {
    await showBleGuidance('蓝牙已关闭。请开启蓝牙后再扫描设备。', {
      label: '打开蓝牙设置',
      run: platform.openBluetoothSettings,
    });
    throw new Error('蓝牙已关闭，请开启蓝牙后重试');
  }

  const sdk = platform.getSdkInt();
  if (sdk <= 30 && !platform.isLocationEnabled()) {
    await showBleGuidance('定位服务已关闭。Android 11 及以下扫描蓝牙设备需要开启系统定位。', {
      label: '打开定位设置',
      run: platform.openLocationSettings,
    });
    throw new Error('定位服务已关闭，无法扫描蓝牙设备');
  }

  // plugin-blec's Rust command currently drops its Android `allowIbeacons`
  // argument before calling the mobile plugin. On Android <= 11 that makes
  // checkPermissions() report success without requesting location, followed
  // by a valid-looking scan that can never return advertisements. Ask through
  // the Activity bridge first, then automatically continue after the system
  // permission sheet closes.
  if (!platform.hasBleScanPermission()) {
    platform.requestBleScanPermission();
    const granted = await waitForBlePermission(platform);
    if (!granted) {
      const permissionName = sdk >= 31 ? '“附近的设备”权限' : '位置信息权限';
      await showBleGuidance(`请允许 0xNuller 的${permissionName}，才能扫描和连接蓝牙设备。`, {
        label: '打开应用设置',
        run: platform.openAppSettings,
      });
      throw new Error(`未授予${permissionName}`);
    }
  }

  try {
    return await connectCall();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/权限|permission/i.test(message)) {
      const permissionName = sdk >= 31 ? '“附近的设备”权限' : '位置信息权限';
      const explanation =
        sdk >= 31
          ? `请允许 0xNuller 的${permissionName}，才能扫描和连接蓝牙设备。`
          : `Android 11 及以下需要授予 0xNuller ${permissionName}，才能扫描蓝牙设备。`;
      if (platform.isPermissionPermanentlyDenied()) {
        await showBleGuidance(`${explanation} 当前系统不会再次弹出授权框，请到应用设置中开启。`, {
          label: '打开应用设置',
          run: platform.openAppSettings,
        });
      } else {
        window.alert(explanation);
      }
    } else if (/location.*(off|disabled)|定位.*关闭/i.test(message)) {
      await showBleGuidance('定位服务已关闭。请开启系统定位后再扫描设备。', {
        label: '打开定位设置',
        run: platform.openLocationSettings,
      });
    } else if (/bluetooth.*(off|disabled)|蓝牙.*关闭/i.test(message)) {
      await showBleGuidance('蓝牙已关闭。请开启蓝牙后再扫描设备。', {
        label: '打开蓝牙设置',
        run: platform.openBluetoothSettings,
      });
    }
    throw error;
  }
}

async function waitForBlePermission(platform: BlePlatform, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (platform.hasBleScanPermission()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return platform.hasBleScanPermission();
}

/** Decorate connect in place so prototype methods remain available to Agent. */
export function withConnectPermissionHelp<T extends { connect(): Promise<void> }>(inner: T): T {
  const rawConnect = inner.connect.bind(inner);
  inner.connect = () => withBlePermissionHelp(rawConnect);
  return inner;
}

export function installAndroidShellBehaviours(): void {
  syncStatusBarColor();
  autoScrollFocusedInput();
  syncVisualViewport();
  interceptBackButton();
}
