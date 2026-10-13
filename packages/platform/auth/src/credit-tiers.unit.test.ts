import { describe, expect, it } from 'vitest';
import { CREDIT_TIERS, normalizeRedeemCode } from './credit-tiers';

describe('Credit 档位', () => {
  it('沿用常见的 6/30/68/128/328/648 档，到账是整数，大档每元不少于小档', () => {
    expect(CREDIT_TIERS.map((tier) => [tier.amountCny, tier.credits])).toEqual([
      [6, 1_000],
      [30, 5_000],
      [68, 12_000],
      [128, 23_000],
      [328, 60_000],
      [648, 120_000],
    ]);
    const perYuan = CREDIT_TIERS.map((tier) => tier.credits / tier.amountCny);
    expect([...perYuan].sort((a, b) => a - b)).toEqual(perYuan);
  });

  it('卡密输入忽略空格、横线和大小写，只接受 64 位合法字符', () => {
    const code = 'A2'.repeat(32);
    expect(normalizeRedeemCode(code.toLowerCase().replace(/(.{8})/g, '$1-'))).toBe(code);
    expect(normalizeRedeemCode(code.slice(1))).toBeNull();
    expect(normalizeRedeemCode('0'.repeat(64))).toBeNull();
  });
});
