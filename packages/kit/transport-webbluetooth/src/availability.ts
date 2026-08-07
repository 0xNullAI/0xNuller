import type { NavigatorBluetoothLike, WebBluetoothAvailability } from '@dg-kit/protocol';

export function getWebBluetoothAvailability(
  nav: NavigatorBluetoothLike | undefined = typeof navigator === 'undefined'
    ? undefined
    : (navigator as unknown as NavigatorBluetoothLike),
): WebBluetoothAvailability {
  if (!nav) {
    return { supported: false, reason: '当前环境中无法访问浏览器导航对象' };
  }

  if (!nav.bluetooth) {
    return {
      supported: false,
      reason: '当前环境不支持 Web Bluetooth，请使用 Chrome 或 Edge，并通过 HTTPS 或 localhost 访问',
    };
  }

  return { supported: true };
}
