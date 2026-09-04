import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { grantDeviceLease } from '@dg-kit/safety';
import { stopAllDevices, reportStopFailure } from '@0xnullai/ui';
import { moduleIdFromPath } from '../../../apps/web/src/routes';

/** Window close waits for acknowledged output stop. Returning never restores a lease by itself. */
export function DesktopLifecycle() {
  const [paused, setPaused] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    let disposed = false;
    let pendingClose = false;
    const unlisten: Array<() => void> = [];
    const stop = async () => {
      setPaused(true);
      await grantDeviceLease(null);
      return stopAllDevices();
    };
    const register = (name: string, handler: () => void) => {
      void listen(name, handler).then(
        (off) => (disposed ? off() : unlisten.push(off)),
        () => reportStopFailure('桌面生命周期监听失败'),
      );
    };
    register('app://paused', () => {
      void stop().catch(() => reportStopFailure('桌面后台停止'));
    });
    register('app://close-requested', () => {
      if (pendingClose) return;
      pendingClose = true;
      setClosing(true);
      void stop()
        .then(async (stopped) => {
          if (stopped) await invoke('desktop_finish_exit');
        })
        .catch(() => reportStopFailure('桌面退出停止'))
        .finally(() => {
          pendingClose = false;
          setClosing(false);
        });
    });
    return () => {
      disposed = true;
      for (const off of unlisten) off();
    };
  }, []);
  if (!paused) return null;
  return (
    <div
      role="status"
      className="fixed bottom-3 left-1/2 z-[100] flex max-w-[90vw] -translate-x-1/2 items-center gap-3 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-3 text-sm shadow-lg"
    >
      <span>{closing ? '正在确认设备停止后退出…' : '已撤销设备控制权'}</span>
      <button
        type="button"
        disabled={closing}
        onClick={() => {
          void grantDeviceLease(moduleIdFromPath(window.location.pathname)).then(() =>
            setPaused(false),
          );
        }}
        className="shrink-0 rounded-[var(--radius-ctl)] bg-[var(--accent)] px-3 py-2 text-[var(--button-text)]"
      >
        继续操作
      </button>
    </div>
  );
}
