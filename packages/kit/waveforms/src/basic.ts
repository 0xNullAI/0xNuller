import type { WaveformDefinition, WaveformLibrary } from '@dg-kit/core';

const BUILTIN_WAVEFORMS: WaveformDefinition[] = [
  {
    id: 'breath',
    name: '呼吸',
    description: '渐强渐弱，最温柔的铺垫波形',
    frames: [
      [10, 0],
      [10, 20],
      [10, 40],
      [10, 60],
      [10, 80],
      [10, 100],
      [10, 100],
      [10, 100],
      [10, 0],
      [10, 0],
      [10, 0],
      [10, 0],
    ],
    modality: 'electrostimulation',
  },
  {
    id: 'tide',
    name: '潮汐',
    description: '波浪般起伏的慢节奏',
    frames: [
      [10, 0],
      [11, 16],
      [13, 33],
      [14, 50],
      [16, 66],
      [18, 83],
      [19, 100],
      [21, 92],
      [22, 84],
      [24, 76],
      [26, 68],
      [26, 0],
      [27, 16],
      [29, 33],
      [30, 50],
      [32, 66],
      [34, 83],
      [35, 100],
      [37, 92],
      [38, 84],
      [40, 76],
      [42, 68],
    ],
    modality: 'electrostimulation',
  },
  {
    id: 'pulse_low',
    name: '低脉冲',
    description: '轻柔的规律节奏',
    frames: Array.from({ length: 10 }, () => [10, 30] as [number, number]),
    modality: 'electrostimulation',
  },
  {
    id: 'pulse_mid',
    name: '中脉冲',
    description: '中等强度的规律节奏',
    frames: Array.from({ length: 10 }, () => [10, 60] as [number, number]),
    modality: 'electrostimulation',
  },
  {
    id: 'pulse_high',
    name: '高脉冲',
    description: '强烈的规律节奏',
    frames: Array.from({ length: 10 }, () => [10, 100] as [number, number]),
    modality: 'electrostimulation',
  },
  {
    id: 'tap',
    name: '敲击',
    description: '带节奏停顿的点触感',
    frames: [
      [10, 100],
      [10, 0],
      [10, 0],
      [10, 100],
      [10, 0],
      [10, 0],
    ],
    modality: 'electrostimulation',
  },
  {
    id: 'vibration_constant',
    name: '持续',
    description: '稳定持续的震动输出',
    frames: [[10, 100]],
    modality: 'vibration',
  },
  {
    id: 'vibration_pulse',
    name: '缓拍',
    description: '半秒震动、半秒停顿的舒缓节奏',
    frames: [
      ...Array.from({ length: 20 }, () => [10, 100] as [number, number]),
      ...Array.from({ length: 20 }, () => [10, 0] as [number, number]),
    ],
    modality: 'vibration',
  },
  {
    id: 'vibration_wave',
    name: '波浪',
    description: '一秒完成一次平滑起伏，并保持马达可起振的低谷',
    frames: Array.from(
      { length: 40 },
      (_, index) =>
        [10, Math.round(35 + 32.5 * (1 + Math.sin((index / 40) * 2 * Math.PI)))] as [
          number,
          number,
        ],
    ),
    modality: 'vibration',
  },
  {
    id: 'vibration_ramp',
    name: '渐强',
    description: '从可感知的轻震逐步推进到强震',
    frames: Array.from(
      { length: 40 },
      (_, index) => [10, Math.round(30 + ((index + 1) / 40) * 70)] as [number, number],
    ),
    modality: 'vibration',
  },
  {
    id: 'vibration_heartbeat',
    name: '心跳',
    description: '两次短促震动后停顿',
    frames: [
      ...Array.from({ length: 6 }, () => [10, 100] as [number, number]),
      ...Array.from({ length: 6 }, () => [10, 0] as [number, number]),
      ...Array.from({ length: 6 }, () => [10, 80] as [number, number]),
      ...Array.from({ length: 30 }, () => [10, 0] as [number, number]),
    ],
    modality: 'vibration',
  },
];

class BasicWaveformLibrary implements WaveformLibrary {
  private readonly byId = new Map(
    BUILTIN_WAVEFORMS.map((waveform) => [waveform.id, cloneWaveform(waveform)]),
  );

  async getById(id: string): Promise<WaveformDefinition | null> {
    const waveform = this.byId.get(id);
    return waveform ? cloneWaveform(waveform) : null;
  }

  async list(): Promise<WaveformDefinition[]> {
    return [...this.byId.values()].map(cloneWaveform);
  }
}

export function createBasicWaveformLibrary(): WaveformLibrary {
  return new BasicWaveformLibrary();
}

export function listBuiltinWaveforms(): WaveformDefinition[] {
  return BUILTIN_WAVEFORMS.map(cloneWaveform);
}

function cloneWaveform(waveform: WaveformDefinition): WaveformDefinition {
  return {
    ...waveform,
    frames: waveform.frames.map((frame) => [frame[0], frame[1]]),
  };
}
