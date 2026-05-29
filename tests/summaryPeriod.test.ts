import { describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({
  salaryRows: [] as unknown[],
}));

vi.mock('../src/services/supabase', () => ({
  supabase: {
    from: vi.fn(() => {
      const state: {
        from?: string;
        to?: string;
        ascending: boolean;
        limit?: number;
      } = { ascending: true };

      const resolve = () => {
        let data = [...rows.salaryRows] as { date?: string }[];
        if (state.from) {
          data = data.filter((row) => String(row.date) >= state.from!);
        }
        if (state.to) {
          data = data.filter((row) => String(row.date) <= state.to!);
        }
        data.sort((a, b) =>
          state.ascending
            ? String(a.date).localeCompare(String(b.date))
            : String(b.date).localeCompare(String(a.date)),
        );
        if (state.limit) data = data.slice(0, state.limit);
        return { data, error: null };
      };

      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        gte: vi.fn((_column: string, value: string) => {
          state.from = value;
          return builder;
        }),
        lte: vi.fn((_column: string, value: string) => {
          state.to = value;
          return builder;
        }),
        order: vi.fn((_column: string, options: { ascending: boolean }) => {
          state.ascending = options.ascending;
          return builder;
        }),
        limit: vi.fn((value: number) => {
          state.limit = value;
          return Promise.resolve(resolve());
        }),
        then: (
          onFulfilled?: (value: { data: unknown[]; error: null }) => unknown,
        ) => Promise.resolve(resolve()).then(onFulfilled),
      };

      return builder;
    }),
  },
}));

import { resolveSummaryPeriod } from '../src/handlers/summaryPeriod';

describe('resolveSummaryPeriod', () => {
  it('resolves this_month from first day of current month through today', async () => {
    vi.setSystemTime(new Date('2026-05-29T10:00:00.000Z'));

    await expect(resolveSummaryPeriod('this_month', 'acc-1')).resolves.toEqual({
      ok: true,
      from: '2026-05-01',
      to: '2026-05-29',
      label: 'calendar',
    });

    vi.useRealTimers();
  });

  it('resolves latest salary_cycle from the month of the latest Gaji transaction', async () => {
    vi.setSystemTime(new Date('2026-05-29T10:00:00.000Z'));
    rows.salaryRows = [
      { date: '2026-04-25', categories: { name: 'Gaji' } },
      { date: '2026-05-25', categories: { name: 'Gaji' } },
    ];

    await expect(resolveSummaryPeriod('salary_cycle', 'acc-1')).resolves.toEqual({
      ok: true,
      from: '2026-05-25',
      to: '2026-05-29',
      label: 'salary_cycle',
    });

    vi.useRealTimers();
    rows.salaryRows = [];
  });

  it('uses earliest Gaji in requested month and one day before latest Gaji in next month', async () => {
    rows.salaryRows = [
      { date: '2026-02-25', categories: { name: 'Gaji' } },
      { date: '2026-02-28', categories: { name: 'Gaji' } },
      { date: '2026-03-24', categories: { name: 'Gaji' } },
      { date: '2026-03-27', categories: { name: 'Gaji' } },
    ];

    await expect(
      resolveSummaryPeriod('salary_cycle', 'acc-1', {
        salaryMonth: 2,
        salaryYear: 2026,
      }),
    ).resolves.toEqual({
      ok: true,
      from: '2026-02-25',
      to: '2026-03-26',
      label: 'salary_cycle',
    });

    rows.salaryRows = [];
  });

  it('uses today as salary_cycle end when next month has no Gaji yet', async () => {
    vi.setSystemTime(new Date('2026-05-29T10:00:00.000Z'));
    rows.salaryRows = [
      { date: '2026-05-25', categories: { name: 'Gaji' } },
      { date: '2026-05-28', categories: { name: 'Gaji' } },
    ];

    await expect(
      resolveSummaryPeriod('salary_cycle', 'acc-1', {
        salaryMonth: 5,
        salaryYear: 2026,
      }),
    ).resolves.toEqual({
      ok: true,
      from: '2026-05-25',
      to: '2026-05-29',
      label: 'salary_cycle',
    });

    vi.useRealTimers();
    rows.salaryRows = [];
  });

  it('returns salary_not_found when no Gaji income transaction exists', async () => {
    rows.salaryRows = [{ date: '2026-05-01', categories: { name: 'Bonus' } }];

    await expect(resolveSummaryPeriod('salary_cycle', 'acc-1')).resolves.toEqual({
      ok: false,
      reason: 'salary_not_found',
    });

    rows.salaryRows = [];
  });
});
