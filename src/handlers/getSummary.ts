import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { formatIDR } from '../utils/format';
import { Lang } from '../utils/lang';
import { AIResponse, Account, IncomingMessage } from '../ai/types';
import { resolveSummaryPeriod } from './summaryPeriod';

export async function getSummary(
  ai: AIResponse,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  const period = ai.payload.period || 'this_month';
  const periodResult = await resolveSummaryPeriod(period, account.id, {
    salaryMonth: ai.payload.salary_month,
    salaryYear: ai.payload.salary_year,
  });

  if (!periodResult.ok) {
    const reply =
      periodResult.reason === 'salary_not_found'
        ? lang === 'id'
          ? 'Belum ada pemasukan kategori *Gaji*. Catat gaji dulu, lalu coba */rekap gaji*.'
          : 'No income transaction categorized as *Gaji* was found. Record salary first, then try */summary salary*.'
        : lang === 'id'
          ? 'Gagal mengambil periode ringkasan.'
          : 'Failed to resolve summary period.';
    await sendWA(msg.chatId, reply);
    return;
  }

  const { from, to } = periodResult;

  const { data: txns } = await supabase
    .from('transactions')
    .select('amount, type, categories(name)')
    .eq('account_id', account.id)
    .gte('date', from)
    .lte('date', to);

  const rows = txns ?? [];
  const income = rows
    .filter((txn) => txn.type === 'income')
    .reduce((sum, txn) => sum + Number(txn.amount), 0);
  const expense = rows
    .filter((txn) => txn.type === 'expense')
    .reduce((sum, txn) => sum + Number(txn.amount), 0);
  const net = income - expense;

  const byCategory: Record<string, number> = {};
  for (const txn of rows.filter((row) => row.type === 'expense')) {
    const name = (txn.categories as any)?.name ?? 'Lainnya';
    byCategory[name] = (byCategory[name] ?? 0) + Number(txn.amount);
  }

  const topCategories = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const netStr = (net >= 0 ? '+' : '-') + 'Rp' + formatIDR(Math.abs(net));

  const catLines =
    topCategories.length > 0
      ? '\n\n' +
        (lang === 'id' ? '🔺 *Top Pengeluaran:*' : '🔺 *Top Expenses:*') +
        '\n' +
        topCategories
          .map(
            (category, index) =>
              index +
              1 +
              '. ' +
              category[0] +
              ' - Rp' +
              formatIDR(category[1]) +
              ' (' +
              Math.round((category[1] / expense) * 100) +
              '%)',
          )
          .join('\n')
      : '';

  const dashUrl = process.env.DASHBOARD_URL ?? '';
  const titleId =
    periodResult.label === 'salary_cycle'
      ? 'Ringkasan Sejak Gaji '
      : 'Ringkasan ';
  const titleEn =
    periodResult.label === 'salary_cycle'
      ? 'Summary Since Salary '
      : 'Summary ';
  const reply =
    lang === 'id'
      ? '📊 *' +
        titleId +
        from +
        ' s/d ' +
        to +
        '*\n\n' +
        '💰 Pemasukan  : +Rp' +
        formatIDR(income) +
        '\n' +
        '💸 Pengeluaran: -Rp' +
        formatIDR(expense) +
        '\n' +
        '🏦 Saldo      : ' +
        netStr +
        catLines +
        (dashUrl ? '\n\n📱 Dashboard: ' + dashUrl : '')
      : '📊 *' +
        titleEn +
        from +
        ' to ' +
        to +
        '*\n\n' +
        '💰 Income  : +Rp' +
        formatIDR(income) +
        '\n' +
        '💸 Expense : -Rp' +
        formatIDR(expense) +
        '\n' +
        '🏦 Balance : ' +
        netStr +
        catLines +
        (dashUrl ? '\n\n📱 Dashboard: ' + dashUrl : '');

  await sendWA(msg.chatId, reply);
}
