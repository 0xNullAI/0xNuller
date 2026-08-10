import { describe, expect, it } from 'vitest';
import { isCoyoteOutputActive } from './index';

describe('isCoyoteOutputActive', () => {
  it('强度已设置但波形未启动时仍是待机', () => {
    expect(
      isCoyoteOutputActive({
        strengthA: 5,
        strengthB: 0,
        waveActiveA: false,
        waveActiveB: false,
      }),
    ).toBe(false);
  });

  it('波形已启动但强度为零时仍是待机', () => {
    expect(
      isCoyoteOutputActive({
        strengthA: 0,
        strengthB: 0,
        waveActiveA: true,
        waveActiveB: false,
      }),
    ).toBe(false);
  });

  it('同一通道同时有强度和运行波形时才算输出', () => {
    expect(
      isCoyoteOutputActive({
        strengthA: 5,
        strengthB: 0,
        waveActiveA: true,
        waveActiveB: false,
      }),
    ).toBe(true);
  });

  it('A 通道强度不能与 B 通道波形交叉误判', () => {
    expect(
      isCoyoteOutputActive({
        strengthA: 5,
        strengthB: 0,
        waveActiveA: false,
        waveActiveB: true,
      }),
    ).toBe(false);
  });
});
