import {
  readPrivateConversationSelection,
  subscribePrivateConversationSelection,
} from '@0xnullai/auth';
import { useScenes, usePublicMarketPortrait } from '@0xnullai/scenes/react';
import { SelectedCharacterPortrait } from '@0xnullai/auth/appearance-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Phone, PhoneOff, Radio, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, Badge, Button } from '@0xnullai/ui';
import { openAppSettings } from '@0xnullai/native';
import type { RealtimeCallState } from '@voice/hooks/use-realtime-call';
import { CharacterVoiceField } from './CharacterVoiceField';
import type { RealtimeTranscriptEntry } from '@voice/lib/realtime/realtime-session';

interface CallPanelProps {
  call: RealtimeCallState;
  onStart: () => void;
  onHangUp: () => void;
  onEmergencyStop: () => void;
  onRetryHistory?: () => void;
}

export function CallPanel({
  call,
  onStart,
  onHangUp,
  onEmergencyStop,
  onRetryHistory,
}: CallPanelProps) {
  const [scenes] = useScenes();
  const characterId = useSyncExternalStore(
    subscribePrivateConversationSelection,
    () => readPrivateConversationSelection()?.characterId ?? '',
    () => '',
  );
  const publicPortrait = usePublicMarketPortrait(
    scenes.scenes.find((scene) => scene.id === characterId)?.marketPortraitId,
  );
  return (
    <div className="flex min-h-0 flex-col gap-3">
      {call.status !== 'active' && call.status !== 'connecting' && (
        <SelectedCharacterPortrait fallbackSource={publicPortrait} />
      )}
      <p className="text-xs text-[var(--text-faint)]">
        猫愿语音 · 按通话时长消耗 Credit。仅保存最终字幕，不保存录音。
      </p>
      {call.historyError && (
        <Alert variant="destructive">
          <AlertDescription>
            {call.historyError} 未保存字幕暂留当前页面，请在离开前重试。
            <Button size="sm" variant="secondary" onClick={onRetryHistory}>
              重试保存字幕
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {call.status === 'active' || call.status === 'connecting' ? (
        <ActiveCallView
          call={call}
          portraitSource={publicPortrait}
          onHangUp={onHangUp}
          onEmergencyStop={onEmergencyStop}
        />
      ) : (
        <IdleCallView
          call={call}
          voiceField={characterId ? <CharacterVoiceField characterId={characterId} /> : null}
          onStart={onStart}
        />
      )}
    </div>
  );
}

function IdleCallView({
  call,
  voiceField,
  onStart,
}: {
  call: RealtimeCallState;
  voiceField: ReactNode;
  onStart: () => void;
}) {
  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-soft)]">
          <Radio className="h-4 w-4" />
          实时语音通话
        </h2>
        <Badge variant="default">{call.status === 'ended' ? '已挂断' : '未开始'}</Badge>
      </div>

      {call.error && (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>
            {call.error}
            {call.errorOpensAppSettings && (
              <Button size="sm" variant="secondary" onClick={() => openAppSettings()}>
                去设置
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {voiceField}

      <Button className="w-full" onClick={onStart}>
        <Phone className="h-4 w-4" />
        开始通话
      </Button>
    </section>
  );
}

function ActiveCallView({
  call,
  portraitSource,
  onHangUp,
  onEmergencyStop,
}: {
  call: RealtimeCallState;
  portraitSource: string | null;
  onHangUp: () => void;
  onEmergencyStop: () => void;
}) {
  const elapsed = useElapsedSeconds(call.startedAt);
  const connecting = call.status === 'connecting';

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-6 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-6 py-10 text-center">
      {call.error && (
        <Alert variant="destructive" className="w-full text-left">
          <AlertDescription>{call.error}</AlertDescription>
        </Alert>
      )}

      <div className="relative flex min-h-28 items-center justify-center">
        {call.speaking && (
          <span className="pointer-events-none absolute h-24 w-24 animate-ping rounded-full bg-[var(--accent)]/20 motion-reduce:animate-none" />
        )}
        <div className="relative rounded-2xl bg-[var(--accent)]/10 p-2">
          <SelectedCharacterPortrait speaking={call.speaking} fallbackSource={portraitSource} />
        </div>
      </div>

      <div className="space-y-1" role="status" aria-live="polite">
        <p className="text-base font-semibold">{connecting ? '正在连接…' : '通话中'}</p>
        <p className="text-xs text-[var(--text-faint)]">
          {connecting
            ? '猫愿语音'
            : `${formatElapsed(elapsed)} · ${call.speaking ? 'AI 正在说话' : '等待语音'}`}
        </p>
      </div>

      {call.transcript.length > 0 && <TranscriptLog transcript={call.transcript} />}

      <div className="flex w-full max-w-sm gap-3">
        <Button
          variant="secondary"
          className="h-12 flex-1 border-[var(--danger-border)] text-base text-[var(--danger-button)] hover:bg-[var(--danger-soft)]"
          onClick={onEmergencyStop}
        >
          <ShieldAlert className="h-4 w-4" />
          设备归零
        </Button>
        <Button variant="destructive" className="h-12 flex-1 text-base" onClick={onHangUp}>
          <PhoneOff className="h-4 w-4" />
          结束通话
        </Button>
      </div>
    </section>
  );
}

/** Running conversation log — auto-scrolls to the newest line as turns stream in. */
function TranscriptLog({ transcript }: { transcript: RealtimeTranscriptEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [transcript]);

  // Skip placeholder entries reserved for ordering (e.g. the user's line, held
  // in place before a late input transcription) until they fill in.
  const visible = transcript.filter((entry) => entry.text.trim() !== '');

  return (
    <div className="max-h-56 w-full space-y-2 overflow-y-auto rounded-[var(--radius-ctl)] bg-[var(--bg-soft)] px-4 py-3 text-left text-sm">
      {visible.map((entry) => (
        <p
          key={entry.id}
          className={entry.role === 'assistant' ? 'text-[var(--text)]' : 'text-[var(--text-soft)]'}
        >
          <span className="text-[var(--text-faint)]">
            {entry.role === 'assistant' ? 'AI：' : '你：'}
          </span>
          {entry.text}
        </p>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => setNow(Date.now());
    // Deferred to a macrotask (not called synchronously in the effect body)
    // so `now` snaps to the real start time right away instead of waiting a
    // full second for the first interval tick.
    const immediate = setTimeout(tick, 0);
    const interval = setInterval(tick, 1000);
    return () => {
      clearTimeout(immediate);
      clearInterval(interval);
    };
  }, [startedAt]);

  if (startedAt === null) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}
