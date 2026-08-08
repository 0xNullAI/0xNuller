import { getVersion } from '@tauri-apps/api/app';

export interface AndroidUpdateStatus {
  hasUpdate: boolean;
  dismissed: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
}

export interface UpdateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TauriUpdateCheckerOptions {
  /** GitHub `owner/repo` to poll releases on, e.g. "0xNullAI/0xNuller". */
  repo: string;
  /**
   * 只认这个前缀的 release tag，默认 `android-v`。
   *
   * **不能用 `releases/latest`。** 合并后这一个仓库同时发布 `@dg-kit/*`（changesets
   * 打出 `@dg-kit/core@1.14.0` 这种 tag）和平台自身的 `v0.1.0`，`releases/latest`
   * 返回的多半不是 APK。那些 tag 用点号切开后第一段是非数字，会被当成 0，于是
   * 比较结果恒为「没有更新」——安卓端的更新提示就此静默失效，而安卓没有热更新，
   * 用户会一直留在旧版本上，不会有任何报错提示这件事出了问题。
   */
  tagPrefix?: string;
  pollIntervalMs?: number;
  firstCheckDelayMs?: number;
  storage?: UpdateStorage;
  getCurrentVersion?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

const DISMISSED_KEY = 'dg-agent-android-update-dismissed-version';
const DEFAULT_TAG_PREFIX = 'android-v';

function inMemoryStorage(): UpdateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

/** 纯数字点分版本号，如 `5.4.2`。 */
const VERSION_RE = /^\d+(\.\d+)*$/;

/**
 * 把 release tag 还原成版本号；不是本应用的 tag 就返回 null。
 *
 * 宁可漏也不能错认：认错一个 tag 的后果是弹出指向别的产物的更新提示，
 * 用户点进去下到的不是 APK。
 */
export function versionFromTag(tag: string, prefix: string): string | null {
  if (!tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  return VERSION_RE.test(version) ? version : null;
}

/** Compares dotted numeric version strings (e.g. "5.4.2"); true iff `remote` is strictly newer than `current`. */
export function isNewerVersion(remote: string, current: string): boolean {
  const remoteParts = remote.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const currentParts = current.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(remoteParts.length, currentParts.length);
  for (let i = 0; i < length; i++) {
    const r = remoteParts[i] ?? 0;
    const c = currentParts[i] ?? 0;
    if (r !== c) return r > c;
  }
  return false;
}

/**
 * Polls GitHub's `releases/latest` API and compares its tag against the
 * running APK's own versionName (via Tauri's `getVersion()`). This app is
 * side-loaded (no Play Store), so there's no silent-update path — the most
 * this can do is surface a dismissible prompt pointing at the release page,
 * where the user downloads + installs the new APK themselves through
 * Android's own package installer.
 */
export class TauriUpdateChecker {
  private dismissed = false;
  private latestVersion: string | null = null;
  private releaseUrl: string | null = null;
  private currentVersion: string | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(status: AndroidUpdateStatus) => void>();
  private readonly storage: UpdateStorage;

  constructor(private readonly options: TauriUpdateCheckerOptions) {
    this.storage =
      options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : inMemoryStorage());
  }

  start(): void {
    this.timeoutId = setTimeout(() => {
      void this.checkOnce();
    }, this.options.firstCheckDelayMs ?? 5_000);
    this.intervalId = setInterval(
      () => {
        void this.checkOnce();
      },
      this.options.pollIntervalMs ?? 60 * 60_000,
    );
  }

  stop(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  dismiss(): void {
    this.dismissed = true;
    if (this.latestVersion) {
      this.storage.setItem(DISMISSED_KEY, this.latestVersion);
    }
    this.emit();
  }

  subscribe(listener: (status: AndroidUpdateStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): AndroidUpdateStatus {
    return {
      hasUpdate: Boolean(
        this.latestVersion &&
        this.currentVersion &&
        !this.dismissed &&
        isNewerVersion(this.latestVersion, this.currentVersion),
      ),
      dismissed: this.dismissed,
      latestVersion: this.latestVersion,
      releaseUrl: this.releaseUrl,
    };
  }

  private async checkOnce(): Promise<void> {
    try {
      const getCurrentVersion = this.options.getCurrentVersion ?? getVersion;
      const fetchImpl = this.options.fetchImpl ?? fetch;
      if (this.currentVersion === null) {
        this.currentVersion = await getCurrentVersion();
      }

      // 列表而不是 `releases/latest`：同一个仓库还发布 @dg-kit/* 与平台版本，
      // 「最新的那个 release」经常不是 APK。
      const response = await fetchImpl(
        `https://api.github.com/repos/${this.options.repo}/releases?per_page=30`,
        { headers: { Accept: 'application/vnd.github+json' } },
      );
      if (!response.ok) return;

      const releases = (await response.json()) as {
        tag_name?: string;
        html_url?: string;
        draft?: boolean;
        prerelease?: boolean;
      }[];
      if (!Array.isArray(releases)) return;

      const prefix = this.options.tagPrefix ?? DEFAULT_TAG_PREFIX;
      // GitHub 按创建时间倒序返回，所以第一条匹配的就是最新的 APK 发布。
      // 草稿与预发布跳过：它们的 APK 要么还不存在，要么不该推给普通用户。
      let version: string | null = null;
      let url: string | null = null;
      for (const release of releases) {
        if (release.draft || release.prerelease) continue;
        const parsed =
          typeof release.tag_name === 'string' ? versionFromTag(release.tag_name, prefix) : null;
        if (!parsed) continue;
        version = parsed;
        url = typeof release.html_url === 'string' ? release.html_url : null;
        break;
      }
      if (!version) return;

      this.latestVersion = version;
      this.releaseUrl = url;
      this.dismissed = this.storage.getItem(DISMISSED_KEY) === version;
      this.emit();
    } catch {
      // ignore transient update-check failures — same policy as the web
      // update checker (services/update-checker.ts): a failed poll just
      // retries on the next interval instead of surfacing an error.
    }
  }

  private emit(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}
