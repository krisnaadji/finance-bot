import { supabase } from './supabase';
import { isRecord, isUuid } from '../utils/financialValidation';

export type FinanceCategory = { id: string | null; name: string; amount: string };
export type FinanceSummaryRow = {
  id: string;
  date: string;
  description: string;
  amount: string;
  category: string;
};
export type FinanceSummary = {
  income: string;
  expense: string;
  net: string;
  categories: FinanceCategory[];
  spendingByCategoryId: Record<string, string>;
  byMonth: Record<string, { income: string; expense: string }>;
  topExpenses: FinanceSummaryRow[];
  topIncomes: FinanceSummaryRow[];
};
export function cents(amount: string): bigint {
  if (!SIGNED_DECIMAL.test(amount)) throw new Error('invalid_finance_amount');
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole, fraction] = unsigned.split('.');
  const value = BigInt(whole) * 100n + BigInt(fraction);
  return negative ? -value : value;
}

export function formatCents(amount: bigint): string {
  const absolute = amount < 0n ? -amount : amount;
  return `${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
export type FinanceBudgetSpending = { spendingByCategoryId: Record<string, string> };

const DECIMAL = /^(?:0|[1-9]\d*)\.\d{2}$/;
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)\.\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

function decimal(value: unknown, signed = false): value is string {
  if (typeof value !== 'string' || !(signed ? SIGNED_DECIMAL : DECIMAL).test(value)) return false;
  return value !== '-0.00';
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function decimalMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error('invalid_finance_report');
  const result: Record<string, string> = {};
  for (const [key, amount] of Object.entries(value)) {
    if (!isUuid(key) || !decimal(amount)) throw new Error('invalid_finance_report');
    result[key] = amount;
  }
  return result;
}

function decodeCategory(value: unknown): FinanceCategory {
  if (!isRecord(value) || (value.id !== null && !isUuid(value.id)) ||
      typeof value.name !== 'string' || !decimal(value.amount)) throw new Error('invalid_finance_summary');
  return { id: value.id, name: value.name, amount: value.amount };
}

function decodeRows(value: unknown): FinanceSummaryRow[] {
  if (!Array.isArray(value)) throw new Error('invalid_finance_summary');
  return value.map((row) => {
    if (!isRecord(row) || !isUuid(row.id) || !validDate(row.date) || typeof row.description !== 'string' ||
        !decimal(row.amount) || typeof row.category !== 'string') throw new Error('invalid_finance_summary');
    return { id: row.id, date: row.date, description: row.description, amount: row.amount, category: row.category };
  });
}

export function decodeFinanceSummary(value: unknown): FinanceSummary {
  if (!isRecord(value) || !decimal(value.income) || !decimal(value.expense) || !decimal(value.net, true) ||
      !Array.isArray(value.categories) || !isRecord(value.byMonth)) throw new Error('invalid_finance_summary');
  const byMonth: FinanceSummary['byMonth'] = {};
  for (const [month, totals] of Object.entries(value.byMonth)) {
    if (!MONTH.test(month) || !isRecord(totals) || !decimal(totals.income) || !decimal(totals.expense)) {
      throw new Error('invalid_finance_summary');
    }
    byMonth[month] = { income: totals.income, expense: totals.expense };
  }
  return {
    income: value.income,
    expense: value.expense,
    net: value.net,
    categories: value.categories.map(decodeCategory),
    spendingByCategoryId: decimalMap(value.spendingByCategoryId),
    byMonth,
    topExpenses: decodeRows(value.topExpenses),
    topIncomes: decodeRows(value.topIncomes),
  };
}

export function decodeFinanceBudgetSpending(value: unknown): FinanceBudgetSpending {
  if (!isRecord(value)) throw new Error('invalid_finance_budget_spending');
  try {
    return { spendingByCategoryId: decimalMap(value.spendingByCategoryId) };
  } catch {
    throw new Error('invalid_finance_budget_spending');
  }
}

export async function getFinanceSummary(accountId: string, from: string, to: string): Promise<FinanceSummary> {
  const { data, error } = await supabase.rpc('finance_summary', {
    p_account_id: accountId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error('finance_summary_unavailable');
  return decodeFinanceSummary(data);
}

export async function getFinanceBudgetSpending(accountId: string, from: string, to: string): Promise<FinanceBudgetSpending> {
  const { data, error } = await supabase.rpc('finance_budget_spending', {
    p_account_id: accountId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error('finance_budget_spending_unavailable');
  return decodeFinanceBudgetSpending(data);
}
