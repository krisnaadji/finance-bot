import { describe, expect, it } from 'vitest';
import { parseAmount, isBusinessDate } from '../src/utils/financialValidation';

describe('financial values', () => {
  it.each([
    [35000, '35000.00'], [' 35000.50 ', '35000.50'],
    ['0001.2300', '1.23'], ['0.01', '0.01'],
    ['9999999999999.99', '9999999999999.99'],
  ])('preserves a valid amount %s', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each([
    '', ' ', null, true, [], {}, 0, -1, NaN, Infinity,
    '1.001', '9999999999999.991', '10000000000000', '1e3',
    '0.0000', '1,000', '35000 rupiah',
  ])('rejects an invalid amount %s instead of rounding', (input) => {
    expect(parseAmount(input)).toBeNull();
  });

  it.each(['2000-02-29', '2024-02-29', '2026-04-30', '2100-12-31'])
    ('accepts a real date %s', (date) => expect(isBusinessDate(date)).toBe(true));
  it.each(['2026-02-29', '2026-02-30', '2100-02-29', '2026-04-31',
    '1999-12-31', '2101-01-01', '2026-2-01', '2026-01-01T00:00:00Z'])
    ('rejects a rolled-over date %s', (date) => expect(isBusinessDate(date)).toBe(false));
});
