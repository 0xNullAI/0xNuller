import { describe, it, expect } from 'vitest';
import {
  attachedDeviceSummaries,
  holdsAnyDevice,
  type AttachedDeviceState,
} from './attached-devices';

function state(overrides: Partial<AttachedDeviceState> = {}): AttachedDeviceState {
  return {
    connected: false,
    deviceInfo: null,
    battery: null,
    strengthA: 0,
    strengthB: 0,
    limitA: 50,
    limitB: 50,
    sensor: null,
    opossum: null,
    ...overrides,
  };
}

const COYOTE = {
  connected: true,
  deviceInfo: { name: '47L121000' },
  battery: 88,
  strengthA: 12,
  strengthB: 0,
};

const OPOSSUM = {
  connected: true,
  deviceName: 'Opossum-01',
  battery: 60,
  intensityA: 0,
  intensityB: 0,
};

const PAW_PRINTS = {
  kind: 'paw-prints',
  connected: true,
  deviceName: '爪印-7',
  battery: 42,
};

describe('holdsAnyDevice', () => {
  it('什么都没连时为假', () => {
    expect(holdsAnyDevice(state())).toBe(false);
  });

  it('只连了郊狼时为真', () => {
    expect(holdsAnyDevice(state(COYOTE))).toBe(true);
  });

  it('只连了负鼠时也为真——否则全局停止按钮不会出现', () => {
    expect(holdsAnyDevice(state({ opossum: OPOSSUM }))).toBe(true);
  });

  it('只连了传感器时也为真', () => {
    expect(holdsAnyDevice(state({ sensor: PAW_PRINTS }))).toBe(true);
  });

  it('设备对象存在但已断开时为假', () => {
    expect(holdsAnyDevice(state({ opossum: { ...OPOSSUM, connected: false } }))).toBe(false);
  });
});

describe('attachedDeviceSummaries', () => {
  it('什么都没连时返回空列表', () => {
    expect(attachedDeviceSummaries(state())).toEqual([]);
  });

  it('郊狼带上双通道读数与上限', () => {
    const [coyote] = attachedDeviceSummaries(state(COYOTE));
    expect(coyote).toMatchObject({
      id: 'coyote',
      kind: 'coyote',
      name: '47L121000',
      connected: true,
      battery: 88,
      active: true,
      channels: [
        { label: 'A', value: 12, max: 50 },
        { label: 'B', value: 0, max: 50 },
      ],
    });
  });

  it('郊狼两个通道都是零时不算在输出', () => {
    const [coyote] = attachedDeviceSummaries(state({ ...COYOTE, strengthA: 0, strengthB: 0 }));
    expect(coyote?.active).toBe(false);
  });

  it('没有设备名时退回「郊狼」', () => {
    const [coyote] = attachedDeviceSummaries(state({ ...COYOTE, deviceInfo: null }));
    expect(coyote?.name).toBe('郊狼');
  });

  it('电量未知时不带 battery 字段', () => {
    const [coyote] = attachedDeviceSummaries(state({ ...COYOTE, battery: null }));
    expect(coyote).not.toHaveProperty('battery');
  });

  it('四种设备各占一条，缺一不可', () => {
    const summaries = attachedDeviceSummaries(
      state({ ...COYOTE, opossum: OPOSSUM, sensor: PAW_PRINTS }),
    );
    expect(summaries.map((d) => d.kind)).toEqual(['coyote', 'opossum', 'paw-prints']);
  });

  it('灵猫边缘传感器按自己的类型上报，而不是笼统的 sensor', () => {
    const summaries = attachedDeviceSummaries(
      state({ sensor: { ...PAW_PRINTS, kind: 'civet-edging', deviceName: '' } }),
    );
    expect(summaries[0]).toMatchObject({ id: 'civet-edging', kind: 'civet-edging', name: '灵猫' });
  });

  it('负鼠有强度时标记为正在输出', () => {
    const summaries = attachedDeviceSummaries(state({ opossum: { ...OPOSSUM, intensityB: 5 } }));
    expect(summaries[0]?.active).toBe(true);
  });

  it('已断开的设备不出现在设备栏里', () => {
    const summaries = attachedDeviceSummaries(
      state({
        ...COYOTE,
        opossum: { ...OPOSSUM, connected: false },
        sensor: { ...PAW_PRINTS, connected: false },
      }),
    );
    expect(summaries.map((d) => d.id)).toEqual(['coyote']);
  });
});
