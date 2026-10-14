import { supabase } from '../services/supabase';
import { businessDate, calendarMonth, currentMonthRange, shiftCivilDay } from '../utils/businessDate';

export type SummaryPeriod =
  | 'this_month'
  | 'last_month'
  | 'this_week'
  | 'salary_cycle'
  | string;

export type SummaryPeriodResult =
  | {
      ok: true;
      from: string;
      to: string;
      label: 'calendar' | 'salary_cycle';
    }
  | { ok: false; reason: 'salary_not_found' | 'query_failed' };

export type SalaryPeriodTarget = {
  salaryMonth?: number;
  salaryYear?: number;
};

type SalaryRow = {
  date?: string;
  categories?: unknown;
};

function resolveCalendarPeriod(period: string, now: Date): SummaryPeriodResult {
  const today = businessDate(now);
  const [year, month] = today.split('-').map(Number);
  if (period === 'last_month') {
    return { ok: true, ...calendarMonth(year, month - 1), label: 'calendar' };
  }
  if (period === 'this_week') {
    const weekday = new Date(today + 'T00:00:00Z').getUTCDay() || 7;
    return { ok: true, from: shiftCivilDay(today, 1 - weekday), to: today, label: 'calendar' };
  }
  return { ok: true, ...currentMonthRange(now), label: 'calendar' };
}

function monthBounds(month: number, year: number): { from: string; to: string } {
  return calendarMonth(year, month);
}

function nextMonth(month: number, year: number): { month: number; year: number } {
  const [nextYear, nextMonth] = calendarMonth(year, month + 1).from.split('-').map(Number);
  return { month: nextMonth, year: nextYear };
}

function isGajiRow(row: SalaryRow): boolean {
  const name = (row.categories as any)?.name;
  return typeof name === 'string' && name.toLowerCase() === 'gaji' && !!row.date;
}

async function fetchSalaryRows(
  accountId: string,
  options: {
    from?: string;
    to?: string;
    ascending: boolean;
    limit?: number;
  },
): Promise<{ rows: SalaryRow[]; error: unknown }> {
  let query = supabase
    .from('transactions')
    .select('date, categories!inner(name)')
    .eq('account_id', accountId)
    .eq('type', 'income')
    .eq('categories.name', 'Gaji')
    .order('date', { ascending: options.ascending });

  if (options.from) query = query.gte('date', options.from);
  if (options.to) query = query.lte('date', options.to);
  if (options.limit) query = query.limit(options.limit);

  const { data, error } = await query;
  if (error || !Array.isArray(data)) return { rows: [], error: error ?? new Error('Salary lookup unavailable') };
  return { rows: (data as SalaryRow[]).filter(isGajiRow), error: null };
}

export async function resolveSummaryPeriod(
  period: SummaryPeriod,
  accountId: string,
  target: SalaryPeriodTarget = {},
  referenceInstant: Date = new Date(),
): Promise<SummaryPeriodResult> {
  if (period !== 'salary_cycle') return resolveCalendarPeriod(period, referenceInstant);

  let salaryMonth = target.salaryMonth;
  let salaryYear = target.salaryYear;

  if (!salaryMonth || !salaryYear) {
    const latest = await fetchSalaryRows(accountId, {
      ascending: false,
      limit: 1,
    });

    if (latest.error) return { ok: false, reason: 'query_failed' };
    if (!latest.rows.length) return { ok: false, reason: 'salary_not_found' };

    const [year, month] = String(latest.rows[0].date).split('-').map(Number);
    salaryMonth = month;
    salaryYear = year;
  }

  const currentBounds = monthBounds(salaryMonth, salaryYear);
  const currentSalary = await fetchSalaryRows(accountId, {
    ...currentBounds,
    ascending: true,
  });

  if (currentSalary.error) return { ok: false, reason: 'query_failed' };
  if (!currentSalary.rows.length) {
    return { ok: false, reason: 'salary_not_found' };
  }

  const following = nextMonth(salaryMonth, salaryYear);
  const followingBounds = monthBounds(following.month, following.year);
  const nextSalary = await fetchSalaryRows(accountId, {
    ...followingBounds,
    ascending: false,
  });

  if (nextSalary.error) return { ok: false, reason: 'query_failed' };

  const nextMarker = nextSalary.rows[0]?.date;
  const to = nextMarker ? shiftCivilDay(String(nextMarker), -1) : businessDate(referenceInstant);

  return {
    ok: true,
    from: String(currentSalary.rows[0].date),
    to,
    label: 'salary_cycle',
  };
}
