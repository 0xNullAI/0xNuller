import { Bluetooth, Radio, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useDeviceSession } from '@/hooks/use-device-session';

const DEVICE_ROWS: Array<{
  key: 'coyote' | 'opossum' | 'pawPrints' | 'civetEdging';
  label: string;
}> = [
  { key: 'coyote', label: '郊狼' },
  { key: 'opossum', label: '负鼠' },
  { key: 'pawPrints', label: '爪印' },
  { key: 'civetEdging', label: '灵猫' },
];

export function App() {
  const { state, error, connectDevice, emergencyStop } = useDeviceSession();

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="flex items-center justify-between border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3">
        <h1 className="text-lg font-semibold">DG-Voice</h1>
        <Button variant="ghost" size="sm" onClick={connectDevice}>
          <Bluetooth className="h-4 w-4" />
          连接设备
        </Button>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-4 py-6">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <section className="rounded-[14px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4">
          <h2 className="mb-3 text-sm font-semibold text-[var(--text-soft)]">设备状态</h2>
          <div className="grid grid-cols-2 gap-3">
            {DEVICE_ROWS.map((row) => {
              const device = state[row.key];
              return (
                <div
                  key={row.key}
                  className="flex items-center justify-between rounded-[10px] border border-[var(--surface-border)] px-3 py-2"
                >
                  <span className="text-sm">{row.label}</span>
                  <Badge variant={device.connected ? 'success' : 'default'}>
                    {device.connected ? '已连接' : '未连接'}
                  </Badge>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-[14px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--text-soft)]">
            <Radio className="h-4 w-4" />
            实时语音通话
          </h2>
          <p className="text-sm text-[var(--text-faint)]">
            实时语音连接（xAI / OpenAI / Azure / 智谱 GLM）尚在开发中，即将上线。
          </p>
        </section>

        <Button
          variant="destructive"
          className="w-full"
          onClick={() => void emergencyStop()}
        >
          <ShieldAlert className="h-4 w-4" />
          紧急停止
        </Button>
      </main>
    </div>
  );
}
