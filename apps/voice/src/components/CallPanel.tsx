import { useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Radio, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, Badge, Button } from '@0xnullai/ui';
import type { RealtimeCallState } from '@voice/hooks/use-realtime-call';
import type { RealtimeTranscriptEntry } from '@voice/lib/realtime/realtime-session';
import { getRealtimeProviderDefinition, type RealtimeProviderId } from '@voice/lib/realtime/providers';

interface CallPanelProps {
  call: RealtimeCallState;
  providerId: RealtimeProviderId;
  onStart: () => void;
  onHangUp: () => void;
  onEmergencyStop: () => void;
}

export function CallPanel({ call, providerId, onStart, onHangUp, onEmergencyStop }: CallPanelProps) {
  if (call.status === 'active' || call.status === 'connecting') {
    return (
      <ActiveCallView
        call={call}
        providerId={providerId}
        onHangUp={onHangUp}
        onEmergencyStop={onEmergencyStop}
      />
    );
  }
  return <IdleCallView call={call} providerId={providerId} onStart={onStart} />;
}

function IdleCallView({
  call,
  providerId,
  onStart,
}: {
  call: RealtimeCallState;
  providerId: RealtimeProviderId;
  onStart: () => void;
}) {
  const provider = getRealtimeProviderDefinition(providerId);

  return (
    <section className="rounded-[14px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-soft)]">
          <Radio className="h-4 w-4" />
          实时语音通话
        </h2>
        <Badge variant="default">{call.status === 'ended' ? '已挂断' : '未开始'}</Badge>
      </div>

      {call.error && (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{call.error}</AlertDescription>
        </Alert>
      )}

      <p className="mb-3 text-xs text-[var(--text-faint)]">
        当前 provider：{provider?.name ?? providerId}
        {provider?.pricePerMinuteUsd ? ` · 约 $${provider.pricePerMinuteUsd}/分钟` : ''}
      </p>

      <Button className="w-full" onClick={onStart}>
        <Phone className="h-4 w-4" />
        开始通话
      </Button>
    </section>
  );
}

function ActiveCallView({
  call,
  providerId,
  onHangUp,
  onEmergencyStop,
}: {
  call: RealtimeCallState;
  providerId: RealtimeProviderId;
  onHangUp: () => void;
  onEmergencyStop: () => void;
}) {
  const provider = getRealtimeProviderDefinition(providerId);
  const elapsed = useElapsedSeconds(call.startedAt);
  const connecting = call.status === 'connecting';

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-6 rounded-[14px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-6 py-10 text-center">
      {call.error && (
        <Alert variant="destructive" className="w-full text-left">
          <AlertDescription>{call.error}</AlertDescription>
        </Alert>
      )}

      <div className="relative flex h-28 w-28 items-center justify-center">
        {call.speaking && (
          <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent)]/30" />
        )}
        <span
          className={`absolute inset-0 rounded-full bg-[var(--accent)]/15 transition-transform duration-500 ${
            call.speaking ? 'scale-110' : 'scale-100'
          }`}
        />
        <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--button-text)]">
          <Radio className="h-8 w-8" />
        </span>
      </div>

      <div className="space-y-1">
        <p className="text-base font-semibold">{connecting ? '正在连接…' : '通话中'}</p>
        <p className="text-xs text-[var(--text-faint)]">
          {provider?.name ?? providerId}
          {!connecting && ` · ${formatElapsed(elapsed)}`}
          {!connecting && call.speaking && ' · AI 正在说话'}
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
          紧急停止
        </Button>
        <Button variant="destructive" className="h-12 flex-1 text-base" onClick={onHangUp}>
          <PhoneOff className="h-4 w-4" />
          结束通话
        </Button>
      </div>
      <p className="-mt-3 text-[11px] text-[var(--text-faint)]">紧急停止只把设备归零，不挂断通话</p>
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
  // in place before GLM sends its late input transcription) until they fill in.
  const visible = transcript.filter((entry) => entry.text.trim() !== '');

  return (
    <div className="max-h-56 w-full space-y-2 overflow-y-auto rounded-[10px] bg-[var(--bg-soft)] px-4 py-3 text-left text-sm">
      {visible.map((entry) => (
        <p
          key={entry.id}
          className={entry.role === 'assistant' ? 'text-[var(--text)]' : 'text-[var(--text-soft)]'}
        >
          <span className="text-[var(--text-faint)]">{entry.role === 'assistant' ? 'AI：' : '你：'}</span>
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
