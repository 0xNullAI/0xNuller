export interface TauriBlecAvailability {
  supported: boolean;
  reason?: string;
}

interface WindowWithTauri {
  __TAURI_INTERNALS__?: unknown;
}

export function getTauriBlecAvailability(): TauriBlecAvailability {
  const win = (globalThis as { window?: WindowWithTauri }).window;
  if (!win) {
    return { supported: false, reason: '当前环境不是 Tauri 应用' };
  }
  if (!win.__TAURI_INTERNALS__) {
    return {
      supported: false,
      reason: '未检测到 Tauri 运行时（缺少 __TAURI_INTERNALS__）',
    };
  }
  return { supported: true };
}
