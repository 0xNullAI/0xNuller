if (!(window as Window & { __NULLER_UNSUPPORTED__?: boolean }).__NULLER_UNSUPPORTED__) {
  void import('./bootstrap').catch(() => {
    const panel = document.createElement('div');
    panel.setAttribute('role', 'alert');
    panel.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:grid;place-content:center;gap:16px;padding:24px;background:#111827;color:white;text-align:center';
    const message = document.createElement('p');
    message.textContent = '应用启动失败，请检查网络后重试。';
    const retry = document.createElement('button');
    retry.textContent = '重新加载';
    retry.onclick = () => window.location.reload();
    panel.append(message, retry);
    document.body.append(panel);
  });
}
