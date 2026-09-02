import type { DeviceCommand } from './protocol';
import type { DGLabDevice } from './bluetooth';
import type { WaveformDefinition } from '@0xnullai/waveforms';

let audioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

/** Opossum + LED control surface, present only once the local session exists. */
export interface DeviceSessionContext {
  opossumConnected: boolean;
  sensorConnected: boolean;
  setOpossumIntensity: (channel: 'A' | 'B', value: number) => void;
  opossumBurst: (channel: 'A' | 'B', strength: number, durationMs?: number) => void;
  opossumStop: (channel?: 'A' | 'B') => void;
  setOpossumPattern?: (
    channel: 'A' | 'B',
    pattern: 'constant' | 'pulse' | 'wave' | 'ramp' | 'heartbeat',
  ) => void;
  setLedColor: (target: 'sensor' | 'opossum', color: number) => void;
}

export interface CommandContext {
  device: DGLabDevice | null;
  getWaveform?: (id: string) => WaveformDefinition | undefined;
  /** Opossum/LED control surface. Present whenever a local device session exists (even if only a sensor is connected). */
  session?: DeviceSessionContext;
  /** Show a remote peer's notice without blocking the page. */
  notify?: (text: string) => void;
}

export function executeCommand(cmd: DeviceCommand, ctx?: CommandContext): string {
  const dev = ctx?.device;
  switch (cmd.action) {
    case 'vibrate':
      if (navigator.vibrate) {
        navigator.vibrate(500);
        return '已振动';
      }
      return '当前设备不支持振动';

    case 'alert':
      // Never window.alert here. This command arrives from another member of
      // the room, and a native modal blocks all script and interaction until
      // it is dismissed — including reaching the stop button, while a device
      // is attached to the user's body. Stop has to stay one action away.
      ctx?.notify?.(cmd.d ?? '');
      return '已提示';

    case 'bg':
      if (cmd.d) {
        document.body.style.backgroundColor = cmd.d;
        return `背景已改为 ${cmd.d}`;
      }
      return '缺少颜色参数';

    case 'shake':
      document.body.classList.add('shake-anim');
      setTimeout(() => document.body.classList.remove('shake-anim'), 600);
      return '已抖动';

    case 'beep': {
      try {
        const a = getAudioContext();
        const osc = a.createOscillator();
        const gain = a.createGain();
        osc.frequency.value = 440;
        gain.gain.value = 0.3;
        osc.connect(gain);
        gain.connect(a.destination);
        osc.start();
        osc.stop(a.currentTime + 0.2);
        return '已蜂鸣';
      } catch {
        return '无法播放蜂鸣';
      }
    }

    case 'change_wave':
    case 'start': {
      if (!dev) return '未连接蓝牙设备';
      if (!cmd.c || !cmd.w) return '波形参数缺失';
      const wf = ctx?.getWaveform?.(cmd.w);
      if (!wf) return `波形 ${cmd.w} 未找到`;
      dev.setWave(cmd.c, wf.frames, wf.id, true);
      return `${cmd.c} 通道${cmd.action === 'start' ? '已启动' : '波形已切换为'} ${wf.name}`;
    }

    case 'stop': {
      // Stop is the one command that must never depend on which device is
      // attached. It used to bail when no Coyote was present, so on an
      // Opossum-only session 归零 silently did nothing — while the Opossum
      // sat right there in the same context object.
      const stoppedCoyote = Boolean(dev);
      dev?.stopAll();
      ctx?.session?.opossumStop();
      if (!stoppedCoyote && !ctx?.session?.opossumConnected) return '未连接蓝牙设备';
      return '已停止所有输出';
    }

    case 'stop_wave':
      if (!dev) return '未连接蓝牙设备';
      if (!cmd.c) return '通道参数缺失';
      dev.stopWave(cmd.c);
      return `${cmd.c} 通道已暂停`;

    case 'burst':
      // Reported 「脉冲已发送」 while calling nothing at all — success for an
      // action that never happened. DGLabDevice exposes no burst (the
      // protocol's runBurst is not surfaced through it), so the honest answer
      // is to say it is unavailable rather than to keep claiming it worked.
      return '当前设备不支持脉冲';

    // —— Opossum (vibration controller) ——
    case 'vibrate_stop':
      if (!ctx?.session?.opossumConnected) return '未连接 Opossum 设备';
      ctx.session.opossumStop(cmd.c);
      return cmd.c ? `${cmd.c} 通道振动已停止` : '振动已停止';

    case 'vibrate_burst':
      if (!ctx?.session?.opossumConnected) return '未连接 Opossum 设备';
      if (!cmd.c || cmd.v == null) return '参数缺失';
      ctx.session.opossumBurst(cmd.c, cmd.v, cmd.ms ?? 500);
      return `${cmd.c} 通道脉冲已发送`;

    case 'vibrate_change_pattern':
      if (!ctx?.session?.opossumConnected) return '未连接 Opossum 设备';
      if (!cmd.c || !cmd.pattern || !ctx.session.setOpossumPattern) return '参数缺失';
      ctx.session.setOpossumPattern(cmd.c, cmd.pattern);
      return `${cmd.c} 通道节奏已切换`;

    // —— LED color (shared by paw-prints / civet-edging / opossum) ——
    case 'set_led': {
      if (!ctx?.session) return '当前没有可设置灯光的设备';
      if (cmd.color == null) return '缺少颜色参数';
      // Explicit, both ways. An unrecognised or missing kind used to fall
      // through to the sensor, writing to a device the caller never named.
      // The Coyote has no settable indicator at all.
      if (cmd.kind === 'opossum') {
        // fall through to the opossum branch below
      } else if (cmd.kind !== 'paw-prints' && cmd.kind !== 'civet-edging') {
        return '未知的灯光目标';
      }
      const target = cmd.kind === 'opossum' ? 'opossum' : 'sensor';
      const targetConnected =
        target === 'opossum' ? ctx.session.opossumConnected : ctx.session.sensorConnected;
      if (!targetConnected) {
        return target === 'opossum' ? '未连接 Opossum 设备' : '未连接传感器设备';
      }
      ctx.session.setLedColor(target, cmd.color);
      return '灯光已更新';
    }

    case 'adjust_strength':
    case 'vibrate_adjust':
    case 'set_queue':
    case 'set_play_mode':
    case 'set_interval':
    case 'fire_active':
    case 'fire_release':
      // Intercepted by App.tsx: authoritative owner-side state changes (strength delta / queue / firing aggregation), synced to everyone by broadcastState*.
      return '';

    default:
      return `未知指令: ${(cmd as DeviceCommand).action}`;
  }
}
