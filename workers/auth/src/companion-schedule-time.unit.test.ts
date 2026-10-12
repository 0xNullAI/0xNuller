import { describe, it, expect } from 'vitest';
import {
  nextOccurrence,
  quietUntil,
  validateScheduleConfig,
  type CompanionScheduleConfig,
} from './companion-schedule-time';
const base: CompanionScheduleConfig = {
  kind: 'once',
  localDate: '2027-03-14',
  localTime: '02:30',
  timeZone: 'America/Chicago',
  weekdays: [0],
  quietStart: '22:00',
  quietEnd: '08:00',
  dailyLimit: 1,
  template: '早上好',
};
describe('IANA companion schedule time', () => {
  it('rejects nonexistent one-off times and skips a missing weekly DST occurrence', () => {
    expect(nextOccurrence(base, Date.parse('2027-03-13T00:00Z'))).toBeNull();
    expect(nextOccurrence({ ...base, kind: 'weekly' }, Date.parse('2027-03-13T00:00Z'))?.at).toBe(
      Date.parse('2027-03-21T07:30Z'),
    );
  });
  it('chooses only the first repeated local hour and never runs its second instance', () => {
    const weekly = { ...base, kind: 'weekly' as const, localTime: '01:30' };
    expect(nextOccurrence(weekly, Date.parse('2027-11-07T05:00Z'))?.at).toBe(
      Date.parse('2027-11-07T06:30Z'),
    );
    expect(nextOccurrence(weekly, Date.parse('2027-11-07T06:45Z'))?.at).toBe(
      Date.parse('2027-11-14T07:30Z'),
    );
  });
  it('defers overnight quiet hours and supports half-hour timezone offsets', () => {
    expect(quietUntil(base, Date.parse('2027-01-01T05:00Z'))).toBe(Date.parse('2027-01-01T14:00Z'));
    expect(
      nextOccurrence(
        { ...base, localDate: '2027-01-02', localTime: '09:00', timeZone: 'Asia/Kolkata' },
        Date.parse('2027-01-01T00:00Z'),
      )?.at,
    ).toBe(Date.parse('2027-01-02T03:30Z'));
  });
  it('rejects invalid IANA zones, calendar dates and excessive frequency', () => {
    expect(() => validateScheduleConfig({ ...base, timeZone: 'fake/place' })).toThrow();
    expect(() => validateScheduleConfig({ ...base, localDate: '2027-02-30' })).toThrow();
    expect(() => validateScheduleConfig({ ...base, dailyLimit: 4 })).toThrow();
  });
});
