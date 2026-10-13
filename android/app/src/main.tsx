// No imports here: this module must still run when every other chunk fails to load.
type TauriWindow = Window & {
  __NULLER_UNSUPPORTED__?: boolean;
  __TAURI_INTERNALS__?: { invoke?(command: string): Promise<unknown> };
};

if (!(window as TauriWindow).__NULLER_UNSUPPORTED__) {
  // Every chunk is served from the APK or a verified hot-update bundle on the phone, so a load
  // failure is a damaged local UI, not the network. Offer the UI built into the APK.
  void import('./bootstrap').catch(() => {
    const panel = document.createElement('div');
    panel.setAttribute('role', 'alert');
    panel.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:grid;place-content:center;gap:16px;padding:24px;background:#111827;color:white;text-align:center';
    const message = document.createElement('p');
    message.textContent =
      '应用界面加载失败。请重新加载；仍然失败时，可恢复安装包内置的界面，本地数据会保留。';
    const retry = document.createElement('button');
    retry.textContent = '重新加载';
    retry.onclick = () => window.location.reload();
    const restore = document.createElement('button');
    restore.textContent = '恢复内置界面';
    restore.onclick = () => {
      void Promise.resolve()
        .then(() => (window as TauriWindow).__TAURI_INTERNALS__?.invoke?.('ota_reset'))
        .catch(() => undefined)
        .finally(() => window.location.reload());
    };
    panel.append(message, retry, restore);
    document.body.append(panel);
  });
}

export {};
