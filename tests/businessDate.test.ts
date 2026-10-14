import { expect, it } from 'vitest';
import { businessDate, shiftCivilDay, calendarMonth, currentMonthRange } from '../src/utils/businessDate';

it('uses Jakarta midnight for relative dates and the current reporting window', () => {
  expect(businessDate(new Date('2026-10-12T17:00:00Z'))).toBe('2026-10-13');
  expect(businessDate(new Date('2026-10-12T16:59:59Z'))).toBe('2026-10-12');
  expect(currentMonthRange(new Date('2026-12-31T17:00:00Z'))).toEqual({ from: '2027-01-01', to: '2027-01-01' });
});
it('handles leap days and year rollover without local timezone arithmetic', () => {
  expect(shiftCivilDay('2024-03-01', -1)).toBe('2024-02-29');
  expect(shiftCivilDay('2026-01-01', -1)).toBe('2025-12-31');
  expect(calendarMonth(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  expect(calendarMonth(2026, 13)).toEqual({ from: '2027-01-01', to: '2027-01-31' });
});
it.each(['2026-02-31', '2026-13-01', '2026-2-01', 'garbage'])('refuses invalid civil date %s', day => {
  expect(() => shiftCivilDay(day, -1)).toThrow();
});
