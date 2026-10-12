import { useEffect, useState, useSyncExternalStore } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { DgLabConnectionRegistry } from '@0xnullai/device-runtime';
import { Alert, AlertDescription, Button, Z_TOAST } from '@0xnullai/ui';
import { TauriUpdateChecker, type AndroidUpdateStatus } from '../services/update-checker.js';
import { otaUpdater, type OtaUpdateStatus } from '../services/ota.js';

// Module-level singleton: one poll loop for the app's lifetime, independent
// of this component's own mount/unmount (React.StrictMode double-mounts in
// dev, and re-subscribing must not restart the check schedule).
const checker = new TauriUpdateChecker({ repo: '0xNullAI/0xNuller' });

const OTA_DISMISSED_KEY = 'maoyuan-ota-dismissed-version';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(OTA_DISMISSED_KEY);
  } catch {
    return null;
  }
}

// Rendered as a sibling of <App/>, not inside it — App's `<main>` is a fixed
// `h-[100dvh]` block designed to be reused verbatim across shells, so an
// Android-only banner can't be woven into its layout without touching that
// shared component. `position: fixed` here escapes App's own
// `overflow-hidden` container and paints on top, since this element isn't a
// DOM descendant of it.
export function UpdateBanner({ dglab }: { dglab: DgLabConnectionRegistry }) {
  const [status, setStatus] = useState<AndroidUpdateStatus>(() => checker.getStatus());
  const [ota, setOta] = useState<OtaUpdateStatus>(() => otaUpdater.getStatus());
  const [dismissedOta, setDismissedOta] = useState(readDismissed);
  const [restarting, setRestarting] = useState(false);
  // Restarting reloads the page, so it is never offered while a device is connected.
  const deviceConnected = useSyncExternalStore(
    (listener) => dglab.subscribe(listener),
    () => dglab.list().length > 0,
  );

  useEffect(() => {
    const unsubscribe = checker.subscribe(setStatus);
    checker.start();
    return () => {
      checker.stop();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = otaUpdater.subscribe(setOta);
    otaUpdater.start();
    return () => {
      otaUpdater.stop();
      unsubscribe();
    };
  }, []);

  const restart = async () => {
    setRestarting(true);
    try {
      await dglab.stopAll();
      await otaUpdater.applyNow();
    } finally {
      setRestarting(false);
    }
  };

  // A new APK outranks a UI update: the UI update cannot reach a different native layer.
  if (status.hasUpdate) {
    return (
      <Banner text={`发现新版本 v${status.latestVersion}，需要下载安装包`}>
        <Button variant="secondary" size="sm" onClick={() => checker.dismiss()}>
          忽略此版本
        </Button>
        <Button
          size="sm"
          onClick={() => {
            if (status.releaseUrl) void openUrl(status.releaseUrl);
          }}
        >
          去更新
        </Button>
      </Banner>
    );
  }

  if (ota.phase === 'reload-required') {
    return (
      <Banner text="当前版本已撤回，重新打开后恢复上一版">
        {!deviceConnected && (
          <Button size="sm" disabled={restarting} onClick={() => void restart()}>
            立即重启
          </Button>
        )}
      </Banner>
    );
  }

  if (ota.phase === 'ready' && ota.readyVersion && dismissedOta !== ota.readyVersion) {
    return (
      <Banner
        text={`新版本 v${ota.readyVersion} 已就绪，下次打开自动更新`}
        detail={ota.notes ?? undefined}
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            try {
              localStorage.setItem(OTA_DISMISSED_KEY, ota.readyVersion ?? '');
            } catch {
              /* the banner just comes back next start */
            }
            setDismissedOta(ota.readyVersion);
          }}
        >
          稍后
        </Button>
        {!deviceConnected && (
          <Button size="sm" disabled={restarting} onClick={() => void restart()}>
            立即重启
          </Button>
        )}
      </Banner>
    );
  }

  return null;
}

function Banner({
  text,
  detail,
  children,
}: {
  text: string;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`pointer-events-none fixed inset-x-0 top-0 ${Z_TOAST} flex justify-center px-3 pt-[env(safe-area-inset-top)]`}
    >
      <Alert
        variant="info"
        className="pointer-events-auto mt-2 w-fit max-w-[calc(100%-1rem)] text-center shadow-[var(--shadow)] sm:max-w-[60%]"
      >
        <AlertDescription className="whitespace-normal break-words text-center">
          {text}
          {detail ? <span className="mt-1 block text-xs opacity-80">{detail}</span> : null}
        </AlertDescription>
        <div className="mt-3 flex flex-wrap justify-center gap-2">{children}</div>
      </Alert>
    </div>
  );
}
