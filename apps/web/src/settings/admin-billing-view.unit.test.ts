import { describe, expect, it } from 'vitest';
import {
  chinaDate,
  chinaDayStart,
  formatSignedCredits,
  headlineTotals,
  ledgerFilter,
  ledgerRange,
  redeemCodesCsv,
} from './admin-billing-view';

// 2026-10-13 00:30 in China is still 2026-10-12 in UTC.
const NOW = Date.UTC(2026, 9, 12, 16, 30);

describe('admin billing view rules', () => {
  it('uses China calendar days for presets and custom ranges', () => {
    expect(chinaDate(NOW)).toBe('2026-10-13');
    expect(chinaDayStart(NOW)).toBe(Date.UTC(2026, 9, 12, 16));
    expect(ledgerRange('today', NOW)).toEqual({
      from: Date.UTC(2026, 9, 12, 16),
      to: Date.UTC(2026, 9, 13, 16),
    });
    expect(ledgerRange('7d', NOW).from).toBe(Date.UTC(2026, 9, 6, 16));
    expect(ledgerRange('30d', NOW).from).toBe(Date.UTC(2026, 8, 13, 16));
    expect(ledgerRange('custom', NOW, { from: '2026-10-01', to: '2026-10-02' })).toEqual({
      from: Date.UTC(2026, 8, 30, 16),
      to: Date.UTC(2026, 9, 2, 16),
    });
    expect(ledgerRange('custom', NOW, { from: '', to: 'bad' })).toEqual({});
  });

  it('builds filters without empty fields and strips a leading @', () => {
    expect(ledgerFilter({ username: ' @alice ', group: 'usage', range: { from: 1 } })).toEqual({
      username: 'alice',
      group: 'usage',
      from: 1,
    });
    expect(ledgerFilter({ username: '', group: '', range: {} })).toEqual({});
  });

  it('sums money in from new keys and legacy purchases and keeps signs', () => {
    expect(
      headlineTotals({
        redeem: { entries: 2, credits: 2000 },
        purchase: { entries: 1, credits: 1000 },
        usage: { entries: 9, credits: -350 },
      }),
    ).toEqual({ income: 3000, gift: 0, usage: -350, refund: 0 });
    expect(formatSignedCredits(1000)).toBe('+1,000');
    expect(formatSignedCredits(-20)).toBe('-20');
    expect(formatSignedCredits(0)).toBe('0');
  });

  it('writes CSV with the agreed columns and neutralizes formulas and quotes', () => {
    expect(
      redeemCodesCsv({
        codes: ['AAA', 'BBB'],
        amountCny: 7,
        credits: 1000,
        batchId: 'b1',
        note: '=cmd,"x"',
      }),
    ).toBe(
      'key,amount_cny,credits,batch_id,note\r\n' +
        `AAA,7,1000,b1,"'=cmd,""x"""\r\n` +
        `BBB,7,1000,b1,"'=cmd,""x"""\r\n`,
    );
  });
});
