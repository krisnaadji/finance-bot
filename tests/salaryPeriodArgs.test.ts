import { describe, expect, it, vi } from 'vitest';

import { parseSalaryPeriodArgs } from '../src/handlers/salaryPeriodArgs';

describe('parseSalaryPeriodArgs', () => {
  it('returns empty target for no argument', () => {
    vi.setSystemTime(new Date('2026-05-29T10:00:00.000Z'));
    expect(parseSalaryPeriodArgs('')).toEqual({ ok: true });
    vi.useRealTimers();
  });

  it('parses numeric month with current year when year is omitted', () => {
    vi.setSystemTime(new Date('2026-05-29T10:00:00.000Z'));
    expect(parseSalaryPeriodArgs('1')).toEqual({
      ok: true,
      month: 1,
      year: 2026,
    });
    vi.useRealTimers();
  });

  it('parses Indonesian and English month names', () => {
    vi.setSystemTime(new Date('2026-05-29T10:00:00.000Z'));
    expect(parseSalaryPeriodArgs('jan')).toEqual({
      ok: true,
      month: 1,
      year: 2026,
    });
    expect(parseSalaryPeriodArgs('januari')).toEqual({
      ok: true,
      month: 1,
      year: 2026,
    });
    expect(parseSalaryPeriodArgs('april')).toEqual({
      ok: true,
      month: 4,
      year: 2026,
    });
    vi.useRealTimers();
  });

  it('parses two-digit and four-digit years', () => {
    expect(parseSalaryPeriodArgs('apr 25')).toEqual({
      ok: true,
      month: 4,
      year: 2025,
    });
    expect(parseSalaryPeriodArgs('1 26')).toEqual({
      ok: true,
      month: 1,
      year: 2026,
    });
    expect(parseSalaryPeriodArgs('1 2026')).toEqual({
      ok: true,
      month: 1,
      year: 2026,
    });
  });

  it('rejects invalid month or year shapes', () => {
    expect(parseSalaryPeriodArgs('13')).toEqual({
      ok: false,
      reason: 'invalid_month',
    });
    expect(parseSalaryPeriodArgs('jan twenty')).toEqual({
      ok: false,
      reason: 'invalid_year',
    });
    expect(parseSalaryPeriodArgs('jan 2026 extra')).toEqual({
      ok: false,
      reason: 'too_many_args',
    });
  });
});
