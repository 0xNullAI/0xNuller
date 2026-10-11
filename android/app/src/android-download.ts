export interface DownloadBridge {
  saveDownload?(fileName: string, mimeType: string, base64: string): boolean;
}

export interface NativeDownloadDeps {
  bridge: () => DownloadBridge | undefined;
  notify: (text: string) => void;
  fetchBlob?: (href: string) => Promise<Blob>;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function fileName(anchor: HTMLAnchorElement): string {
  if (anchor.download) return anchor.download;
  try {
    return decodeURIComponent(new URL(anchor.href).pathname.split('/').pop() ?? '') || 'download';
  } catch {
    return 'download';
  }
}

/**
 * Android WebView ignores `<a download>`, so every page export (memories,
 * chats, cards, waveform templates) silently did nothing in the APK. Exports
 * create a link and call `click()` on it, often without attaching it to the
 * document, so the click method itself is intercepted: downloads go to the
 * native bridge, which writes them to the system Downloads folder. Ordinary
 * links keep the default behaviour.
 */
export function installNativeDownloads({
  bridge,
  notify,
  fetchBlob = async (href) => (await fetch(href)).blob(),
}: NativeDownloadDeps): () => void {
  const originalClick = HTMLAnchorElement.prototype.click;
  async function save(anchor: HTMLAnchorElement) {
    const native = bridge();
    if (!native?.saveDownload) {
      notify('当前版本无法保存文件');
      return;
    }
    try {
      const blob = await fetchBlob(anchor.href);
      const saved = native.saveDownload(
        fileName(anchor),
        blob.type,
        base64(new Uint8Array(await blob.arrayBuffer())),
      );
      notify(saved ? '已保存到“下载”' : '保存失败，请重试');
    } catch {
      notify('保存失败，请重试');
    }
  }
  const handles = (anchor: HTMLAnchorElement) => anchor.hasAttribute('download') && !!anchor.href;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (!handles(this)) return originalClick.call(this);
    void save(this);
  };
  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!(anchor instanceof HTMLAnchorElement) || !handles(anchor)) return;
    event.preventDefault();
    void save(anchor);
  };
  document.addEventListener('click', onClick, true);
  return () => {
    HTMLAnchorElement.prototype.click = originalClick;
    document.removeEventListener('click', onClick, true);
  };
}
