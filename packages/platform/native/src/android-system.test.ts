import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureAndroidMediaPermission,
  explainMediaFailure,
  holdScreenAwake,
  MediaPermissionDeniedError,
  readMediaPermissionStatus,
  type AndroidMediaBridge,
  type MediaPermissionStatus,
} from './android-system';

const noWait = () => Promise.resolve();

/** A bridge whose status follows a scripted sequence, one entry per read. */
function scriptedBridge(statuses: MediaPermissionStatus[]) {
  let index = 0;
  const bridge = {
    getMediaPermissionStatus: vi.fn(() => statuses[Math.min(index++, statuses.length - 1)]!),
    requestMediaPermission: vi.fn(),
    openAppSettings: vi.fn(),
  } satisfies AndroidMediaBridge;
  return bridge;
}

describe('ensureAndroidMediaPermission', () => {
  it('passes straight through on the web', async () => {
    await expect(ensureAndroidMediaPermission('camera', { bridge: null })).resolves.toBe(true);
  });

  it('does not ask again when already granted', async () => {
    const bridge = scriptedBridge(['granted']);
    await expect(ensureAndroidMediaPermission('camera', { bridge, wait: noWait })).resolves.toBe(
      true,
    );
    expect(bridge.requestMediaPermission).not.toHaveBeenCalled();
  });

  it('waits for the system sheet and resolves on a grant', async () => {
    const bridge = scriptedBridge(['prompt', 'requesting', 'requesting', 'granted']);
    await expect(ensureAndroidMediaPermission('camera', { bridge, wait: noWait })).resolves.toBe(
      true,
    );
    expect(bridge.requestMediaPermission).toHaveBeenCalledWith('camera');
  });

  it('fails as soon as the user denies, without waiting out the timeout', async () => {
    const bridge = scriptedBridge(['prompt', 'requesting', 'denied']);
    const wait = vi.fn(noWait);
    const result = ensureAndroidMediaPermission('camera', { bridge, wait });
    await expect(result).rejects.toBeInstanceOf(MediaPermissionDeniedError);
    await expect(result).rejects.toMatchObject({ kind: 'camera', permanent: false });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('reports a permanent denial so the page can send the user to settings', async () => {
    const bridge = scriptedBridge(['blocked', 'requesting', 'blocked']);
    await expect(
      ensureAndroidMediaPermission('microphone', { bridge, wait: noWait }),
    ).rejects.toMatchObject({ kind: 'microphone', permanent: true });
  });

  it('stops quietly when the caller is no longer current', async () => {
    const bridge = scriptedBridge(['prompt', 'requesting']);
    await expect(
      ensureAndroidMediaPermission('camera', { bridge, wait: noWait, isCurrent: () => false }),
    ).resolves.toBe(false);
  });

  it('keeps the camera-only check on APKs without the status method', async () => {
    let granted = false;
    const bridge: AndroidMediaBridge = {
      hasCameraPermission: () => granted,
      requestCameraPermission: vi.fn(() => {
        granted = true;
      }),
    };
    await expect(ensureAndroidMediaPermission('camera', { bridge, wait: noWait })).resolves.toBe(
      true,
    );
    await expect(
      ensureAndroidMediaPermission('microphone', { bridge, wait: noWait }),
    ).resolves.toBe(true);
  });
});

describe('explainMediaFailure', () => {
  const cause = new DOMException('Permission denied', 'NotAllowedError');

  it('turns an Android denial into the settings guidance', () => {
    const explained = explainMediaFailure('microphone', cause, scriptedBridge(['blocked']));
    expect(explained).toBeInstanceOf(MediaPermissionDeniedError);
    expect((explained as MediaPermissionDeniedError).permanent).toBe(true);
    expect((explained as Error).message).toContain('去设置');
  });

  it('leaves other failures and the web unchanged', () => {
    expect(explainMediaFailure('microphone', cause, scriptedBridge(['granted']))).toBe(cause);
    expect(explainMediaFailure('microphone', cause, null)).toBe(cause);
  });

  it('ignores an unknown status from a newer or broken bridge', () => {
    const bridge: AndroidMediaBridge = { getMediaPermissionStatus: () => 'weird' };
    expect(readMediaPermissionStatus('camera', bridge)).toBeNull();
  });
});

describe('holdScreenAwake', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'wakeLock');
  });

  it('sets and clears the Android keep-screen-on flag once', () => {
    const setKeepScreenOn = vi.fn();
    const release = holdScreenAwake({ setKeepScreenOn });
    expect(setKeepScreenOn).toHaveBeenLastCalledWith(true);
    release();
    release();
    expect(setKeepScreenOn.mock.calls).toEqual([[true], [false]]);
  });

  it('uses the Screen Wake Lock API on the web and releases it', async () => {
    const sentinel = { release: vi.fn(() => Promise.resolve()) };
    const request = vi.fn(() => Promise.resolve(sentinel));
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    const release = holdScreenAwake(null);
    expect(request).toHaveBeenCalledWith('screen');
    await Promise.resolve();
    await Promise.resolve();
    release();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('releases a lock granted after hang-up', async () => {
    const sentinel = { release: vi.fn(() => Promise.resolve()) };
    let grant: (value: typeof sentinel) => void = () => undefined;
    const request = vi.fn(() => new Promise<typeof sentinel>((resolve) => (grant = resolve)));
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    const release = holdScreenAwake(null);
    release();
    grant(sentinel);
    await vi.waitFor(() => expect(sentinel.release).toHaveBeenCalledTimes(1));
  });

  it('does nothing where neither is available', () => {
    expect(() => holdScreenAwake(null)()).not.toThrow();
  });
});
