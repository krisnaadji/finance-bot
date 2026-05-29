import { supabase } from '../services/supabase';

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

function toISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseISODate(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00');
}

function resolveCalendarPeriod(period: string): SummaryPeriodResult {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  if (period === 'last_month') {
    return {
      ok: true,
      from: toISODate(new Date(y, m - 1, 1)),
      to: toISODate(new Date(y, m, 0)),
      label: 'calendar',
    };
  }

  if (period === 'this_week') {
    const day = now.getDay() || 7;
    const mon = new Date(now);
    mon.setDate(now.getDate() - day + 1);
    return {
      ok: true,
      from: toISODate(mon),
      to: toISODate(now),
      label: 'calendar',
    };
  }

  return {
    ok: true,
    from: toISODate(new Date(y, m, 1)),
    to: toISODate(now),
    label: 'calendar',
  };
}

function monthBounds(month: number, year: number): { from: string; to: string } {
  return {
    from: toISODate(new Date(year, month - 1, 1)),
    to: toISODate(new Date(year, month, 0)),
  };
}

function nextMonth(month: number, year: number): { month: number; year: number } {
  const date = new Date(year, month, 1);
  return { month: date.getMonth() + 1, year: date.getFullYear() };
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
  return { rows: ((data ?? []) as SalaryRow[]).filter(isGajiRow), error };
}

export async function resolveSummaryPeriod(
  period: SummaryPeriod,
  accountId: string,
  target: SalaryPeriodTarget = {},
): Promise<SummaryPeriodResult> {
  if (period !== 'salary_cycle') return resolveCalendarPeriod(period);

  let salaryMonth = target.salaryMonth;
  let salaryYear = target.salaryYear;

  if (!salaryMonth || !salaryYear) {
    const latest = await fetchSalaryRows(accountId, {
      ascending: false,
      limit: 1,
    });

    if (latest.error) return { ok: false, reason: 'query_failed' };
    if (!latest.rows.length) return { ok: false, reason: 'salary_not_found' };

    const latestSalaryDate = parseISODate(String(latest.rows[0].date));
    salaryMonth = latestSalaryDate.getMonth() + 1;
    salaryYear = latestSalaryDate.getFullYear();
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

  const nextMarker = nextSalary.rows[0]?.date
    ? parseISODate(String(nextSalary.rows[0].date))
    : null;
  const toDate = nextMarker
    ? new Date(
        nextMarker.getFullYear(),
        nextMarker.getMonth(),
        nextMarker.getDate() - 1,
      )
    : new Date();

  return {
    ok: true,
    from: String(currentSalary.rows[0].date),
    to: toISODate(toDate),
    label: 'salary_cycle',
  };
}
