import {
  apiBaseUrl,
  androidPushEnabled,
  pendingAndroidPushRevocation,
  setPendingAndroidPushRevocation,
} from '@0xnullai/settings';
import { allowGuardedNavigation } from '@0xnullai/ui';
import {
  authRequestHeaders,
  currentAuthUserId,
  registerBeforeLogout,
  subscribeAuthChanges,
} from '@0xnullai/auth';

export type PushKind = 'ai' | 'dm' | 'group';

export function pushRoute(kind: PushKind, targetId: string): string | null {
  const valid =
    kind === 'group'
      ? /^[A-Za-z0-9_-]{1,128}$/.test(targetId)
      : /^[A-Za-z0-9._:-]{1,128}$/.test(targetId);
  if (!valid) return null;
  const id = encodeURIComponent(targetId);
  if (kind === 'ai') return `/agent?conversation=${id}`;
  if (kind === 'dm') return `/chat?dm=${id}`;
  return `/chat?room=${id}`;
}

export function safePushRoute(route: string): string | null {
  if (route.length > 420 || !route.startsWith('/') || route.startsWith('//')) return null;
  try {
    const url = new URL(route, window.location.origin);
    const candidate =
      url.pathname === '/agent'
        ? (['conversation', 'ai'] as const)
        : url.pathname === '/chat' && url.searchParams.has('dm')
          ? (['dm', 'dm'] as const)
          : url.pathname === '/chat' && url.searchParams.has('room')
            ? (['room', 'group'] as const)
            : null;
    if (!candidate || url.searchParams.size !== 1) return null;
    return pushRoute(candidate[1], url.searchParams.get(candidate[0]) ?? '');
  } catch {
    return null;
  }
}

export function openPushRoute(route: string): boolean {
  const safeRoute = safePushRoute(route);
  if (!safeRoute || !allowGuardedNavigation(safeRoute)) return false;
  // Same-document navigation preserves the mounted native device transport.
  // When called before Shell mounts, its initial route reads this URL.
  if (`${window.location.pathname}${window.location.search}` !== safeRoute)
    window.history.pushState(null, '', safeRoute);
  // A user can select another conversation while the URL stays on an earlier
  // chat link. Dispatch even for the same URL so Chat can open the tapped one.
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  return true;
}

export interface AndroidPushBridge {
  isPushConfigured(): boolean;
  hasNotificationPermission(): boolean;
  requestNotificationPermission(): void;
  ensurePushChannels(): void;
  setPushAccountId(accountId: string): void;
  registerPush(): void;
  unregisterPush(): void;
  getPushRegistrationId(): string;
  /** Optional for older native shells which only expose the FID. */
  getPushInstallationKey?(): string;
  getPreviousPushRegistrationId?(): string;
  consumePushRoute(): string;
  /** Account-bound notification target; legacy route-only bridges are not opened. */
  consumePushTarget?(): string;
}

export function parsePushTarget(value: string): { accountId: string; route: string } | null {
  try {
    const target: unknown = JSON.parse(value);
    if (!target || typeof target !== 'object') return null;
    const { accountId, route } = target as Record<string, unknown>;
    if (typeof accountId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(accountId)) return null;
    if (typeof route !== 'string') return null;
    const safeRoute = safePushRoute(route);
    return safeRoute ? { accountId, route: safeRoute } : null;
  } catch {
    return null;
  }
}

export interface PushRegistrationApi {
  register(
    installationId: string,
    installationKey?: string,
    previousInstallationId?: string,
  ): Promise<void>;
  revoke(
    installationId: string,
    installationKey?: string,
    previousInstallationId?: string,
  ): Promise<void>;
}

export class AndroidPushCoordinator {
  private generation = 0;
  private accountId: string | null = null;
  private registrationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly bridge: AndroidPushBridge,
    private readonly api: PushRegistrationApi,
    private readonly delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private queueRegistration(operation: () => Promise<void>): Promise<void> {
    // A previous account's PUT must settle before the next account binds the
    // same FID, and before logout sends its DELETE. Keep the queue usable after
    // a failed request so a later account can still register.
    const pending = this.registrationTail.then(operation);
    this.registrationTail = pending.catch(() => undefined);
    return pending;
  }

  async setAccount(accountId: string | null): Promise<void> {
    const generation = ++this.generation;
    if (!accountId) {
      this.accountId = null;
      // Revoke locally before any asynchronous network work. The auth package
      // clears its Bearer before announcing logout, so server revocation must
      // also be called explicitly from a pre-logout hook when it is added.
      this.bridge.setPushAccountId('');
      this.bridge.unregisterPush();
      return;
    }
    if (this.accountId && accountId !== this.accountId) {
      this.bridge.setPushAccountId('');
      this.bridge.unregisterPush();
    }
    this.accountId = accountId;
    if (!this.bridge.isPushConfigured()) return;
    this.bridge.ensurePushChannels();
    this.bridge.setPushAccountId(accountId);
    if (!this.bridge.hasNotificationPermission()) {
      this.bridge.requestNotificationPermission();
      for (let attempt = 0; attempt < 50 && generation === this.generation; attempt += 1) {
        if (this.bridge.hasNotificationPermission()) break;
        await this.delay(200);
      }
    }
    if (generation !== this.generation || !this.bridge.hasNotificationPermission()) return;
    this.bridge.registerPush();
    for (let attempt = 0; attempt < 50 && generation === this.generation; attempt += 1) {
      const installationId = this.bridge.getPushRegistrationId();
      if (/^[A-Za-z0-9_-]{16,256}$/.test(installationId)) {
        const nativeKey = this.bridge.getPushInstallationKey?.();
        const installationKey =
          nativeKey && /^[A-Za-z0-9_-]{16,128}$/.test(nativeKey) ? nativeKey : undefined;
        const oldId = this.bridge.getPreviousPushRegistrationId?.();
        const previousInstallationId =
          oldId && /^[A-Za-z0-9_-]{16,256}$/.test(oldId) ? oldId : undefined;
        await this.queueRegistration(async () => {
          if (generation === this.generation)
            await this.api.register(installationId, installationKey, previousInstallationId);
        });
        return;
      }
      await this.delay(200);
    }
  }

  /** Call while the outgoing account still has a Bearer credential. */
  async revokeBeforeLogout(authenticatedAccountId?: string | null): Promise<void> {
    const installationId =
      this.bridge.getPushRegistrationId() || this.bridge.getPreviousPushRegistrationId?.() || '';
    // A Settings opt-out can arrive while initial pending-revocation retry is
    // still running, before setAccount has populated this.accountId. The
    // authenticated account is then the only safe owner for the native FID.
    const outgoingAccount = authenticatedAccountId ?? this.accountId;
    if (outgoingAccount && /^[A-Za-z0-9_-]{16,256}$/.test(installationId))
      setPendingAndroidPushRevocation(outgoingAccount, installationId);
    this.bridge.setPushAccountId('');
    this.bridge.unregisterPush();
    ++this.generation;
    this.accountId = null;
    if (outgoingAccount) await this.retryPendingRevocation(outgoingAccount);
  }

  async retryPendingRevocation(accountId: string): Promise<void> {
    const installationId = pendingAndroidPushRevocation(accountId);
    if (!installationId) return;
    await this.queueRegistration(async () => {
      const nativeKey = this.bridge.getPushInstallationKey?.();
      const installationKey =
        nativeKey && /^[A-Za-z0-9_-]{16,128}$/.test(nativeKey) ? nativeKey : undefined;
      const oldId = this.bridge.getPreviousPushRegistrationId?.();
      const previousInstallationId =
        oldId && /^[A-Za-z0-9_-]{16,256}$/.test(oldId) ? oldId : undefined;
      await this.api.revoke(installationId, installationKey, previousInstallationId);
      if (pendingAndroidPushRevocation(accountId) === installationId)
        setPendingAndroidPushRevocation(accountId, null);
    });
  }
}

export const accountPushApi: PushRegistrationApi = {
  async register(installationId, installationKey, previousInstallationId) {
    const response = await fetch(`${apiBaseUrl()}/api/auth/push/registrations`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authRequestHeaders() },
      body: JSON.stringify({
        provider: 'fcm-fid',
        platform: 'android',
        installationId,
        installationKey,
        previousInstallationId,
      }),
    });
    if (!response.ok) throw new Error(`Push registration failed (${response.status})`);
  },
  async revoke(installationId, installationKey, previousInstallationId) {
    const response = await fetch(
      `${apiBaseUrl()}/api/auth/push/registrations/${encodeURIComponent(installationId)}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...authRequestHeaders() },
        body: JSON.stringify({ installationKey, previousInstallationId }),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Push revocation failed (${response.status})`);
    }
  },
};

export function installAndroidPush(bridge: AndroidPushBridge | undefined): () => void {
  // The server registration/send endpoints are still being connected. Builds
  // without this explicit flag never ask permission or register with FCM.
  if (!bridge) return () => undefined;
  if (import.meta.env.VITE_ANDROID_PUSH_BACKEND_ENABLED !== 'true') {
    bridge.unregisterPush();
    return () => undefined;
  }
  const coordinator = new AndroidPushCoordinator(bridge, accountPushApi);
  let reconcileGeneration = 0;
  let logoutPending = false;
  const reconcile = (accountId: string | null) => {
    const generation = ++reconcileGeneration;
    if (logoutPending || !accountId || !androidPushEnabled(accountId)) {
      void coordinator.setAccount(null);
      if (accountId) void coordinator.retryPendingRevocation(accountId).catch(() => undefined);
      return;
    }
    void coordinator
      .retryPendingRevocation(accountId)
      .then(() => {
        if (
          generation === reconcileGeneration &&
          !logoutPending &&
          currentAuthUserId() === accountId &&
          androidPushEnabled(accountId)
        )
          return coordinator.setAccount(accountId);
      })
      .catch(() => undefined);
  };
  const onPreference = (event: Event) => {
    const detail = (event as CustomEvent<{ accountId?: string; enabled?: boolean }>).detail;
    const accountId = currentAuthUserId();
    if (!accountId || detail?.accountId !== accountId) return;
    if (detail.enabled && androidPushEnabled(accountId)) reconcile(accountId);
    else {
      ++reconcileGeneration;
      void coordinator.revokeBeforeLogout(accountId).catch(() => undefined);
    }
  };
  let pendingOpen = false;
  const openPending = () => {
    // Native validates the locally bound account. The web session must also
    // be confirmed by /me before a notification may select a conversation.
    if (!pendingOpen || !currentAuthUserId()) return;
    pendingOpen = false;
    const target = parsePushTarget(bridge.consumePushTarget?.() ?? '');
    if (target?.accountId === currentAuthUserId()) openPushRoute(target.route);
  };
  // Shell.me() publishes the authoritative signed-out result shortly after
  // mount. Do not revoke a still-valid registration before that check finishes.
  const initialAccountId = currentAuthUserId();
  if (initialAccountId) reconcile(initialAccountId);
  const unsubscribe = subscribeAuthChanges((user) => {
    logoutPending = false;
    if (user?.id) openPending();
    else pendingOpen = false;
    reconcile(user?.id ?? null);
  });
  const unsubscribeBeforeLogout = registerBeforeLogout(() => {
    logoutPending = true;
    ++reconcileGeneration;
    return coordinator.revokeBeforeLogout(currentAuthUserId());
  });
  const onFocus = () => reconcile(currentAuthUserId());
  // The WebView can stay foregrounded through an offline → online transition.
  // Retry both an unsent PUT and a pending DELETE without requiring navigation.
  const onOnline = () => reconcile(currentAuthUserId());
  // Firebase can refresh an FID while the WebView stays foregrounded. Native
  // announces the persisted replacement so Auth receives a fresh binding.
  const onRegistration = () => reconcile(currentAuthUserId());
  const onPushOpen = () => {
    pendingOpen = true;
    openPending();
  };
  window.addEventListener('focus', onFocus);
  window.addEventListener('online', onOnline);
  window.addEventListener('0xnullai:push-registration', onRegistration);
  window.addEventListener('0xnullai:push-open', onPushOpen);
  window.addEventListener('0xnullai:push-preference', onPreference);
  // Cold-start intents arrive before the shell's authenticated /me result.
  pendingOpen = true;
  return () => {
    unsubscribe();
    unsubscribeBeforeLogout();
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('0xnullai:push-registration', onRegistration);
    window.removeEventListener('0xnullai:push-open', onPushOpen);
    window.removeEventListener('0xnullai:push-preference', onPreference);
  };
}
