import { Phone, PhoneOff, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { RealtimeCallState } from '@/hooks/use-realtime-call';
import { getRealtimeProviderDefinition, type RealtimeProviderId } from '@/lib/realtime/providers';

interface CallPanelProps {
  call: RealtimeCallState;
  providerId: RealtimeProviderId;
  onStart: () => void;
  onHangUp: () => void;
}

const STATUS_LABEL: Record<RealtimeCallState['status'], string> = {
  idle: '未开始',
  connecting: '连接中…',
  active: '通话中',
  ended: '已挂断',
};

export function CallPanel({ call, providerId, onStart, onHangUp }: CallPanelProps) {
  const provider = getRealtimeProviderDefinition(providerId);
  const isActive = call.status === 'active' || call.status === 'connecting';

  return (
    <section className="rounded-[14px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-soft)]">
          <Radio className="h-4 w-4" />
          实时语音通话
        </h2>
        <Badge variant={call.status === 'active' ? 'success' : 'default'}>
          {STATUS_LABEL[call.status]}
          {call.status === 'active' && call.speaking ? ' · AI 正在说话' : ''}
        </Badge>
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

      {call.userText && (
        <p className="mb-2 text-sm text-[var(--text-soft)]">
          <span className="text-[var(--text-faint)]">你说：</span>
          {call.userText}
        </p>
      )}
      {call.assistantText && (
        <p className="mb-3 text-sm text-[var(--text)]">
          <span className="text-[var(--text-faint)]">AI：</span>
          {call.assistantText}
        </p>
      )}

      {isActive ? (
        <Button variant="destructive" className="w-full" onClick={onHangUp}>
          <PhoneOff className="h-4 w-4" />
          挂断
        </Button>
      ) : (
        <Button className="w-full" onClick={onStart}>
          <Phone className="h-4 w-4" />
          开始通话
        </Button>
      )}
    </section>
  );
}
