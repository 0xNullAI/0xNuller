import type { UpdateCheckerStatus } from '../services/update-checker.js';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface RenderToastItem {
  key: string;
  text: string;
  variant: 'destructive' | 'warning' | 'info';
  phase: 'entering' | 'visible' | 'exiting';
}

function formatVoiceStateLabel(voiceState: 'idle' | 'listening' | 'speaking'): string {
  switch (voiceState) {
    case 'listening':
      return '录音中';
    case 'speaking':
      return '语音合成中';
    case 'idle':
    default:
      return '空闲';
  }
}

function getToastMotionClass(phase: 'entering' | 'visible' | 'exiting'): string {
  return cn(
    'pointer-events-auto flex justify-center transition-all duration-200 ease-out will-change-transform',
    phase === 'entering' && 'translate-y-[-8px] scale-[0.98] opacity-0',
    phase === 'visible' && 'translate-y-0 scale-100 opacity-100',
    phase === 'exiting' && 'translate-y-[-8px] scale-[0.98] opacity-0',
  );
}

interface FloatingStatusBarProps {
  voiceMode: boolean;
  voiceState: 'idle' | 'listening' | 'speaking';
  voiceTranscript: string;
  errorItems: RenderToastItem[];
  warnings: RenderToastItem[];
  eventToasts: RenderToastItem[];
  updateStatus: UpdateCheckerStatus;
  onDismissUpdate: () => void;
  onReload: () => void;
}

export function FloatingStatusBar({
  voiceMode,
  voiceState,
  voiceTranscript,
  errorItems,
  warnings,
  eventToasts,
  updateStatus,
  onDismissUpdate,
  onReload,
}: FloatingStatusBarProps) {
  if (
    !voiceMode &&
    errorItems.length === 0 &&
    warnings.length === 0 &&
    eventToasts.length === 0 &&
    !updateStatus.hasUpdate
  ) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-[3.5rem] z-40 flex justify-center px-3">
      <div className="flex w-full max-w-[800px] flex-col gap-3">
        {voiceMode && (
          <section className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] rounded-[12px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3 text-center shadow-[var(--shadow)]">
            <div className="text-sm font-medium text-[var(--text)]">
              语音会话状态：{formatVoiceStateLabel(voiceState)}
            </div>
            <div className="mt-1 whitespace-normal break-words text-sm text-[var(--text-soft)]">
              {voiceTranscript || '正在等待语音识别输入…'}
            </div>
          </section>
        )}

        {errorItems.map((item) => (
          <div key={item.key} className={getToastMotionClass(item.phase)}>
            <Alert
              variant={item.variant}
              className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]"
            >
              <AlertDescription className="whitespace-normal break-words text-center">
                {item.text}
              </AlertDescription>
            </Alert>
          </div>
        ))}
        {warnings.map((item) => (
          <div key={item.key} className={getToastMotionClass(item.phase)}>
            <Alert
              variant={item.variant}
              className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]"
            >
              <AlertDescription className="whitespace-normal break-words text-center">
                {item.text}
              </AlertDescription>
            </Alert>
          </div>
        ))}
        {eventToasts.map((item) => (
          <div key={item.key} className={getToastMotionClass(item.phase)}>
            <Alert
              variant={item.variant}
              className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]"
            >
              <AlertDescription className="whitespace-normal break-words text-center">
                {item.text}
              </AlertDescription>
            </Alert>
          </div>
        ))}

        {updateStatus.hasUpdate && (
          <div className="pointer-events-auto flex justify-center">
            <Alert
              variant="info"
              className="w-fit max-w-[calc(100%-1rem)] sm:max-w-[60%] text-center shadow-[var(--shadow)]"
            >
              <AlertDescription className="whitespace-normal break-words text-center">
                检测到新版本，刷新页面可能会中断蓝牙连接与语音会话
              </AlertDescription>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <Button variant="secondary" size="sm" onClick={onDismissUpdate}>
                  稍后提醒
                </Button>
                <Button size="sm" onClick={onReload}>
                  立即刷新
                </Button>
              </div>
            </Alert>
          </div>
        )}
      </div>
    </div>
  );
}
