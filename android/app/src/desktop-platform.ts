import { getAdapterState } from '@mnlphlp/plugin-blec';
/** Desktop BLE uses WinRT/CoreBluetooth, never Android location permissions. */
export async function withDesktopBleHelp<T>(connect: () => Promise<T>): Promise<T> {
  const state = await getAdapterState().catch(() => 'Unknown');
  if (state === 'Off') throw new Error('蓝牙已关闭，请在系统设置中开启蓝牙后重试。');
  try {
    return await connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/permission|unauthorized|denied|not authorized/i.test(message)) {
      throw new Error(
        '未获得蓝牙权限。macOS：系统设置 → 隐私与安全性 → 蓝牙，允许 0xNuller；Windows：检查系统蓝牙开关和设备驱动。',
        { cause: error },
      );
    }
    throw error;
  }
}
export function withDesktopConnectHelp<T extends { connect(): Promise<void> }>(client: T): T {
  const connect = client.connect.bind(client);
  client.connect = () => withDesktopBleHelp(connect);
  return client;
}
