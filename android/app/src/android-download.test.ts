// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installNativeDownloads } from './android-download';

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

function setup(saved = true) {
  const saveDownload = vi.fn(() => saved);
  const notify = vi.fn();
  uninstall = installNativeDownloads({
    bridge: () => ({ saveDownload }),
    notify,
    fetchBlob: async () => new Blob(['{"a":1}'], { type: 'application/json' }),
  });
  return { saveDownload, notify };
}

it('hands a detached export link to the native bridge instead of the WebView', async () => {
  const { saveDownload, notify } = setup();
  const link = document.createElement('a');
  link.href = 'blob:http://localhost/x';
  link.download = '记忆.json';
  link.click();
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('已保存到“下载”'));
  expect(saveDownload).toHaveBeenCalledWith('记忆.json', 'application/json', btoa('{"a":1}'));
});

it('reports a native write failure', async () => {
  const { notify } = setup(false);
  const link = document.createElement('a');
  link.href = 'blob:http://localhost/x';
  link.download = 'x.json';
  link.click();
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('保存失败，请重试'));
});

it('leaves ordinary links alone', () => {
  const { saveDownload } = setup();
  const link = document.createElement('a');
  link.href = '#here';
  const listener = vi.fn((event: Event) => event.preventDefault());
  link.addEventListener('click', listener);
  link.click();
  expect(listener).toHaveBeenCalledOnce();
  expect(saveDownload).not.toHaveBeenCalled();
});
