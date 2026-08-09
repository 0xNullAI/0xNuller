import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TauriUpdateChecker,
  isNewerVersion,
  versionFromTag,
  type UpdateStorage,
} from './update-checker.js';

function memoryStorage(): UpdateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

interface FakeRelease {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/** A single APK release, nothing else in the repo — the simplest case. */
function fetchReturning(tagName: string | undefined, htmlUrl = 'https://example.com/release') {
  return fetchReleases([{ tag_name: tagName, html_url: htmlUrl }]);
}

/** What GitHub's `/releases` returns: a list ordered newest-first by creation time. */
function fetchReleases(releases: FakeRelease[]) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => releases });
}

describe('isNewerVersion', () => {
  it('detects a newer patch version', () => {
    expect(isNewerVersion('5.4.2', '5.4.1')).toBe(true);
  });

  it('detects a newer minor/major version', () => {
    expect(isNewerVersion('6.0.0', '5.4.9')).toBe(true);
    expect(isNewerVersion('5.5.0', '5.4.9')).toBe(true);
  });

  it('is false for an equal or older version', () => {
    expect(isNewerVersion('5.4.1', '5.4.1')).toBe(false);
    expect(isNewerVersion('5.4.0', '5.4.1')).toBe(false);
  });

  it('handles differing segment counts', () => {
    expect(isNewerVersion('5.4', '5.4.0')).toBe(false);
    expect(isNewerVersion('5.4.1', '5.4')).toBe(true);
  });
});

describe('TauriUpdateChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports hasUpdate when the release tag is newer than the running version', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('android-v5.4.2'),
    });

    await checker['checkOnce']();

    const status = checker.getStatus();
    expect(status.hasUpdate).toBe(true);
    expect(status.latestVersion).toBe('5.4.2');
    expect(status.releaseUrl).toBe('https://example.com/release');
  });

  it('does not report hasUpdate when already on the latest version', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.2',
      fetchImpl: fetchReturning('android-v5.4.2'),
    });

    await checker['checkOnce']();

    expect(checker.getStatus().hasUpdate).toBe(false);
  });

  it('dismiss() persists per-version and survives a fresh checker instance', async () => {
    const storage = memoryStorage();
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage,
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('android-v5.4.2'),
    });

    await checker['checkOnce']();
    checker.dismiss();
    expect(checker.getStatus().hasUpdate).toBe(false);

    const reopened = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage,
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('android-v5.4.2'),
    });
    await reopened['checkOnce']();
    expect(reopened.getStatus().hasUpdate).toBe(false);
    expect(reopened.getStatus().dismissed).toBe(true);
  });

  it('a dismissed version does not suppress a subsequent, newer release', async () => {
    const storage = memoryStorage();
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage,
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('android-v5.4.2'),
    });
    await checker['checkOnce']();
    checker.dismiss();

    checker['options'].fetchImpl = fetchReturning('android-v5.4.3');
    await checker['checkOnce']();

    expect(checker.getStatus().hasUpdate).toBe(true);
    expect(checker.getStatus().latestVersion).toBe('5.4.3');
  });

  it('ignores a malformed response instead of throwing', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning(undefined),
    });

    await expect(checker['checkOnce']()).resolves.toBeUndefined();
    expect(checker.getStatus().hasUpdate).toBe(false);
  });

  it('ignores a network error instead of throwing', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')),
    });

    await expect(checker['checkOnce']()).resolves.toBeUndefined();
    expect(checker.getStatus().hasUpdate).toBe(false);
  });

  it('start() schedules an initial check and subsequent polls', async () => {
    const fetchImpl = fetchReturning('android-v5.4.2');
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl,
      firstCheckDelayMs: 1_000,
      pollIntervalMs: 10_000,
    });

    checker.start();
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    checker.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('subscribe() delivers the current status immediately and on change', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('android-v5.4.2'),
    });

    const statuses: boolean[] = [];
    checker.subscribe((status) => statuses.push(status.hasUpdate));

    await checker['checkOnce']();

    expect(statuses).toEqual([false, true]);
  });
});

describe('versionFromTag', () => {
  it('只认本应用的 tag 前缀', () => {
    expect(versionFromTag('android-v5.5.2', 'android-v')).toBe('5.5.2');
    // After the merge the same repo also cuts these tags. Misidentify any one of
    // them and the user taps through and downloads something that is not the APK.
    expect(versionFromTag('@dg-kit/core@1.14.0', 'android-v')).toBeNull();
    expect(versionFromTag('v0.1.0', 'android-v')).toBeNull();
    expect(versionFromTag('dg-mcp@0.3.1', 'android-v')).toBeNull();
  });

  it('前缀之后必须是纯数字点分版本', () => {
    expect(versionFromTag('android-v5.5.2-beta', 'android-v')).toBeNull();
    expect(versionFromTag('android-vnext', 'android-v')).toBeNull();
    expect(versionFromTag('android-v', 'android-v')).toBeNull();
  });
});

describe('合并后的单仓库里挑出 APK 发布', () => {
  it('跳过 @dg-kit/* 与平台版本的 release，找到真正的 APK', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.5.2',
      // The real-world ordering: kit package releases happen every day, the APK
      // once every few weeks, so it is never at the front. With
      // `releases/latest` you always get the first entry and the Android update
      // prompt silently stops working — and since Android has no hot updates,
      // the user gets no signal at all that anything is broken.
      fetchImpl: fetchReleases([
        { tag_name: '@dg-kit/core@1.14.0', html_url: 'https://example.com/kit' },
        { tag_name: 'v0.2.0', html_url: 'https://example.com/platform' },
        { tag_name: 'android-v5.6.0', html_url: 'https://example.com/apk' },
      ]),
    });

    await checker['checkOnce']();

    const status = checker.getStatus();
    expect(status.hasUpdate).toBe(true);
    expect(status.latestVersion).toBe('5.6.0');
    expect(status.releaseUrl).toBe('https://example.com/apk');
  });

  it('一个 APK release 都没有时什么也不提示', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.5.2',
      fetchImpl: fetchReleases([{ tag_name: '@dg-kit/core@1.14.0' }]),
    });

    await checker['checkOnce']();

    expect(checker.getStatus().hasUpdate).toBe(false);
    // Nor may it surface some other artifact's version number.
    expect(checker.getStatus().latestVersion).toBeNull();
  });

  it('跳过草稿与预发布', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.5.2',
      fetchImpl: fetchReleases([
        { tag_name: 'android-v9.9.9', draft: true, html_url: 'https://example.com/draft' },
        { tag_name: 'android-v9.9.8', prerelease: true, html_url: 'https://example.com/pre' },
        { tag_name: 'android-v5.6.0', html_url: 'https://example.com/apk' },
      ]),
    });

    await checker['checkOnce']();

    // A draft's APK has not been uploaded yet, and a prerelease should not be
    // pushed to ordinary users.
    expect(checker.getStatus().latestVersion).toBe('5.6.0');
  });

  it('返回的不是数组时不炸', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.5.2',
      fetchImpl: vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ message: 'Not Found' }) }),
    });

    await expect(checker['checkOnce']()).resolves.toBeUndefined();
    expect(checker.getStatus().hasUpdate).toBe(false);
  });
});
