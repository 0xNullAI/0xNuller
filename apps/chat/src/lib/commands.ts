import type { DeviceCommand } from './protocol';
import type { DGLabDevice } from './bluetooth';
import type { WaveformDefinition } from './waveforms';

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
  setLedColor: (target: 'sensor' | 'opossum', color: number) => void;
}

export interface CommandContext {
  device: DGLabDevice | null;
  getWaveform?: (id: string) => WaveformDefinition | undefined;
  /** Opossum/LED control surface. Present whenever a local device session exists (even if only a sensor is connected). */
  session?: DeviceSessionContext;
}

export function executeCommand(cmd: DeviceCommand, ctx?: CommandContext): string {
  const dev = ctx?.device;
  switch (cmd.action) {
    case 'vibrate':
      if (navigator.vibrate) { navigator.vibrate(500); return '已振动'; }
      return '当前设备不支持振动';

    case 'alert':
      window.alert(cmd.d ?? '');
      return '已弹窗';

    case 'bg':
      if (cmd.d) { document.body.style.backgroundColor = cmd.d; return `背景已改为 ${cmd.d}`; }
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
      } catch { return '无法播放蜂鸣'; }
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

    case 'stop':
      if (!dev) return '未连接蓝牙设备';
      dev.stopAll();
      return '已停止所有输出';

    case 'stop_wave':
      if (!dev) return '未连接蓝牙设备';
      if (!cmd.c) return '通道参数缺失';
      dev.stopWave(cmd.c);
      return `${cmd.c} 通道已暂停`;

    case 'burst':
      if (!dev) return '未连接蓝牙设备';
      return '脉冲已发送';

    // —— Opossum（负鼠振动控制器） ——
    case 'vibrate_stop':
      if (!ctx?.session?.opossumConnected) return '未连接 Opossum 设备';
      ctx.session.opossumStop(cmd.c);
      return cmd.c ? `${cmd.c} 通道振动已停止` : '振动已停止';

    case 'vibrate_burst':
      if (!ctx?.session?.opossumConnected) return '未连接 Opossum 设备';
      if (!cmd.c || cmd.v == null) return '参数缺失';
      ctx.session.opossumBurst(cmd.c, cmd.v, cmd.ms ?? 500);
      return `${cmd.c} 通道脉冲已发送`;

    // —— LED 颜色（paw-prints / civet-edging / opossum 共用） ——
    case 'set_led': {
      if (!ctx?.session) return '当前没有可设置灯光的设备';
      if (cmd.color == null) return '缺少颜色参数';
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
      // 由 App.tsx 拦截：owner 端权威状态变更（强度增量 / 队列 / 开火聚合），由 broadcastState* 同步给所有人。
      return '';

    default:
      return `未知指令: ${(cmd as DeviceCommand).action}`;
  }
}
