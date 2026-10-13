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
  assets?: { name: string }[];
}

const apkAsset = (version: string) => ({ name: `maoyuan-v${version}.apk` });

/** A single APK release, nothing else in the repo — the simplest case. */
function fetchReturning(tagName: string | undefined, htmlUrl = 'https://example.com/release') {
  const version = tagName?.startsWith('v') ? tagName.slice(1) : 'unknown';
  return fetchReleases([{ tag_name: tagName, html_url: htmlUrl, assets: [apkAsset(version)] }]);
}

/** What GitHub's `/releases` returns: a list ordered newest-first by creation time. */
function fetchReleases(releases: FakeRelease[]) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => releases });
}

describe('isNewerVersion', () => {
  it.each([
    ['newer patch', '5.4.2', '5.4.1', true],
    ['newer major', '6.0.0', '5.4.9', true],
    ['newer minor', '5.5.0', '5.4.9', true],
    ['equal', '5.4.1', '5.4.1', false],
    ['older', '5.4.0', '5.4.1', false],
    ['fewer segments, equal', '5.4', '5.4.0', false],
    ['more segments, newer', '5.4.1', '5.4', true],
  ])('%s: isNewerVersion(%s, %s) is %s', (_label, candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected);
  });
});

describe('TauriUpdateChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['5.4.1', true],
    ['5.4.2', false],
  ])('running %s against release v5.4.2 reports hasUpdate=%s', async (current, hasUpdate) => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => current,
      fetchImpl: fetchReturning('v5.4.2'),
    });

    await checker['checkOnce']();

    const status = checker.getStatus();
    expect(status.hasUpdate).toBe(hasUpdate);
    if (hasUpdate) {
      expect(status.latestVersion).toBe('5.4.2');
      expect(status.releaseUrl).toBe('https://example.com/release');
    }
  });

  it('dismiss() persists per-version and survives a fresh checker instance', async () => {
    const storage = memoryStorage();
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage,
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('v5.4.2'),
    });

    await checker['checkOnce']();
    checker.dismiss();
    expect(checker.getStatus().hasUpdate).toBe(false);

    const reopened = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage,
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: fetchReturning('v5.4.2'),
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
      fetchImpl: fetchReturning('v5.4.2'),
    });
    await checker['checkOnce']();
    checker.dismiss();

    checker['options'].fetchImpl = fetchReturning('v5.4.3');
    await checker['checkOnce']();

    expect(checker.getStatus().hasUpdate).toBe(true);
    expect(checker.getStatus().latestVersion).toBe('5.4.3');
  });

  it.each([
    ['a malformed response', () => fetchReturning(undefined)],
    ['a network error', () => vi.fn().mockRejectedValue(new Error('offline'))],
    [
      'a non-array body',
      () => vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: 'Not Found' }) }),
    ],
  ])('tolerates bad release responses: %s', async (_label, makeFetch) => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl: makeFetch(),
    });

    await expect(checker['checkOnce']()).resolves.toBeUndefined();
    expect(checker.getStatus().hasUpdate).toBe(false);
  });

  it('start() schedules an initial check and subsequent polls', async () => {
    const fetchImpl = fetchReturning('v5.4.2');
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.4.1',
      fetchImpl,
      // Scheduling only: one request per check.
      pointerUrl: null,
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
      fetchImpl: fetchReturning('v5.4.2'),
    });

    const statuses: boolean[] = [];
    checker.subscribe((status) => statuses.push(status.hasUpdate));

    await checker['checkOnce']();

    expect(statuses).toEqual([false, true]);
  });
});

describe('versionFromTag', () => {
  // After the merge the same repo also cuts kit/legacy/mcp tags. Misidentify any
  // one of them and the user taps through and downloads something that is not
  // the APK. After the prefix only a purely numeric dotted version counts.
  it.each([
    ['v5.5.2', '5.5.2'],
    ['@dg-kit/core@1.14.0', null],
    ['android-v6.0.0', null],
    ['dg-mcp@0.3.1', null],
    ['v5.5.2-beta', null],
    ['vnext', null],
    ['v', null],
  ])('只认本应用前缀加纯数字版本：%s', (tag, expected) => {
    expect(versionFromTag(tag, 'v')).toBe(expected);
  });
});

describe('合并后的单仓库里挑出 APK 发布', () => {
  it('跳过 @dg-kit/* 与旧 Android tag，找到统一产品 Release', async () => {
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
        { tag_name: 'android-v6.0.0', html_url: 'https://example.com/legacy' },
        { tag_name: 'v5.6.0', html_url: 'https://example.com/apk', assets: [apkAsset('5.6.0')] },
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

  it('忽略使用正确 tag 但没有 APK 的不完整 Release', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.5.2',
      fetchImpl: fetchReleases([
        { tag_name: 'v5.6.0', html_url: 'https://example.com/incomplete', assets: [] },
      ]),
    });

    await checker['checkOnce']();

    expect(checker.getStatus().hasUpdate).toBe(false);
    expect(checker.getStatus().latestVersion).toBeNull();
  });

  it('跳过草稿与预发布', async () => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '5.5.2',
      fetchImpl: fetchReleases([
        {
          tag_name: 'v9.9.9',
          draft: true,
          html_url: 'https://example.com/draft',
          assets: [apkAsset('9.9.9')],
        },
        {
          tag_name: 'v9.9.8',
          prerelease: true,
          html_url: 'https://example.com/pre',
          assets: [apkAsset('9.9.8')],
        },
        { tag_name: 'v5.6.0', html_url: 'https://example.com/apk', assets: [apkAsset('5.6.0')] },
      ]),
    });

    await checker['checkOnce']();

    // A draft's APK has not been uploaded yet, and a prerelease should not be
    // pushed to ordinary users.
    expect(checker.getStatus().latestVersion).toBe('5.6.0');
  });
});

describe('APK pointer on our own domain', () => {
  const POINTER = 'https://0xnullai.com/ota/android/apk.json';
  const page = 'https://github.com/0xNullAI/0xNuller/releases/tag/v7.2.0';

  function routes(pointer: unknown, pointerOk = true) {
    return vi.fn(async (url: string) =>
      url === POINTER
        ? { ok: pointerOk, json: async () => pointer }
        : {
            ok: true,
            json: async () => [{ tag_name: 'v7.1.0', html_url: 'gh', assets: [apkAsset('7.1.0')] }],
          },
    );
  }

  it('reads the pointer first and does not call GitHub', async () => {
    const fetchImpl = routes({ version: '7.2.0', releaseUrl: page });
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '7.1.0',
      fetchImpl: fetchImpl as never,
    });
    await checker['checkOnce']();

    expect(checker.getStatus()).toMatchObject({
      hasUpdate: true,
      latestVersion: '7.2.0',
      releaseUrl: page,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unreachable', { version: '7.2.0', releaseUrl: page }, false],
    ['a malformed version', { version: 'v7.2', releaseUrl: page }, true],
    ['a release page elsewhere', { version: '7.2.0', releaseUrl: 'https://evil.test/apk' }, true],
  ])('falls back to GitHub when the pointer is %s', async (_label, pointer, ok) => {
    const checker = new TauriUpdateChecker({
      repo: '0xNullAI/0xNuller',
      storage: memoryStorage(),
      getCurrentVersion: async () => '7.0.0',
      fetchImpl: routes(pointer, ok) as never,
    });
    await checker['checkOnce']();
    expect(checker.getStatus().latestVersion).toBe('7.1.0');
  });
});
