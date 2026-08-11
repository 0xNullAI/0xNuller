import { describe, it, expect } from 'vitest';
import {
  attachedDeviceSummaries,
  holdsAnyDevice,
  type AttachedCoyoteState,
  type AttachedDeviceState,
} from './attached-devices';

function state(overrides: Partial<AttachedDeviceState> = {}): AttachedDeviceState {
  return {
    coyotes: [],
    sensor: null,
    opossum: null,
    ...overrides,
  };
}

function coyote(overrides: Partial<AttachedCoyoteState> = {}): AttachedCoyoteState {
  return {
    id: 'aa:bb:cc:dd:ee:01',
    name: '47L121000',
    connected: true,
    battery: 88,
    strengthA: 12,
    strengthB: 0,
    limitA: 50,
    limitB: 50,
    waveActiveA: false,
    waveActiveB: false,
    ...overrides,
  };
}

const COYOTE = { coyotes: [coyote()] };

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

  it('郊狼带上双通道读数与上限，但未开波形时保持待机', () => {
    const [first] = attachedDeviceSummaries(state(COYOTE));
    expect(first).toMatchObject({
      id: 'aa:bb:cc:dd:ee:01',
      kind: 'coyote',
      name: '47L121000',
      connected: true,
      battery: 88,
      active: false,
      channels: [
        { label: 'A', value: 12, max: 50 },
        { label: 'B', value: 0, max: 50 },
      ],
    });
  });

  it('郊狼两个通道都是零时不算在输出', () => {
    const [first] = attachedDeviceSummaries(
      state({ coyotes: [coyote({ strengthA: 0, strengthB: 0 })] }),
    );
    expect(first?.active).toBe(false);
  });

  it('同一通道有强度且波形运行时才标记为输出', () => {
    const [first] = attachedDeviceSummaries(
      state({ coyotes: [coyote({ strengthA: 5, waveActiveA: true })] }),
    );
    expect(first?.active).toBe(true);
  });

  it('A 强度与 B 波形不能交叉误报输出', () => {
    const [first] = attachedDeviceSummaries(
      state({ coyotes: [coyote({ strengthA: 5, waveActiveB: true })] }),
    );
    expect(first?.active).toBe(false);
  });

  it('没有设备名时退回「郊狼」', () => {
    const [first] = attachedDeviceSummaries(state({ coyotes: [coyote({ name: '' })] }));
    expect(first?.name).toBe('郊狼');
  });

  it('电量未知时不带 battery 字段', () => {
    const [first] = attachedDeviceSummaries(state({ coyotes: [coyote({ battery: null })] }));
    expect(first).not.toHaveProperty('battery');
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

  it('挂两台郊狼时两台都在清单里，且 id 不相同', () => {
    // The bug this guards: every Coyote used to report id 'coyote', so the
    // device bar's `sessionId:deviceId` key collided and React rendered only
    // the first — the user lost the on-screen proof that a second device was
    // attached to them.
    const summaries = attachedDeviceSummaries(
      state({
        coyotes: [
          coyote({ id: 'aa:bb:cc:dd:ee:01' }),
          coyote({ id: 'aa:bb:cc:dd:ee:02', strengthA: 0, strengthB: 7 }),
        ],
      }),
    );
    expect(summaries).toHaveLength(2);
    expect(summaries.map((d) => d.id)).toEqual(['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02']);
    expect(new Set(summaries.map((d) => d.id)).size).toBe(2);
  });

  it('每台郊狼的通道读数跟着自己那台走', () => {
    const summaries = attachedDeviceSummaries(
      state({
        coyotes: [
          coyote({ id: 'one', strengthA: 3, strengthB: 0, limitA: 30, limitB: 30 }),
          coyote({ id: 'two', strengthA: 0, strengthB: 21, limitA: 40, limitB: 40 }),
        ],
      }),
    );
    expect(summaries[0]?.channels).toEqual([
      { label: 'A', value: 3, max: 30 },
      { label: 'B', value: 0, max: 30 },
    ]);
    expect(summaries[1]?.channels).toEqual([
      { label: 'A', value: 0, max: 40 },
      { label: 'B', value: 21, max: 40 },
    ]);
  });

  it('同型号重名的两台郊狼在名字上要能区分开', () => {
    const summaries = attachedDeviceSummaries(
      state({ coyotes: [coyote({ id: 'one' }), coyote({ id: 'two' })] }),
    );
    expect(summaries.map((d) => d.name)).toEqual(['47L121000 #1', '47L121000 #2']);
  });

  it('只有一台时名字不加编号', () => {
    const summaries = attachedDeviceSummaries(state(COYOTE));
    expect(summaries[0]?.name).toBe('47L121000');
  });

  it('两台里只有一台还连着时，只列出还连着的那台', () => {
    const summaries = attachedDeviceSummaries(
      state({
        coyotes: [coyote({ id: 'one', connected: false }), coyote({ id: 'two' })],
      }),
    );
    expect(summaries.map((d) => d.id)).toEqual(['two']);
  });

  it('任意一台郊狼在输出，就算持有设备', () => {
    expect(
      holdsAnyDevice(
        state({ coyotes: [coyote({ id: 'one', connected: false }), coyote({ id: 'two' })] }),
      ),
    ).toBe(true);
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
    expect(summaries.map((d) => d.id)).toEqual(['aa:bb:cc:dd:ee:01']);
  });
});
