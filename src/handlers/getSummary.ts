import { sendWA } from '../services/whatsapp';
import { getFinanceSummary, cents, formatCents, type FinanceSummary } from '../services/reporting';
import { formatIDR } from '../utils/format';
import { Lang } from '../utils/lang';
import { AIResponse, Account, IncomingMessage } from '../ai/types';
import { resolveSummaryPeriod } from './summaryPeriod';
import { BotWriteError } from './transactionData';
import { t } from '../i18n/bot';

export async function getSummary(
  ai: AIResponse,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  return sendWA(msg.chatId, await summaryReply(ai, account, lang));
}

export async function summaryReply(ai: AIResponse, account: Account, lang: Lang, referenceInstant: Date = new Date()): Promise<string> {
  const period = ai.payload.period || 'this_month';
  const periodResult = await resolveSummaryPeriod(period, account.id, {
    salaryMonth: ai.payload.salary_month,
    salaryYear: ai.payload.salary_year,
  }, referenceInstant);

  if (!periodResult.ok) {
    if (periodResult.reason === 'query_failed') throw new BotWriteError('dependency');
    const reply = lang === 'id'
      ? 'Belum ada pemasukan kategori *Gaji*. Catat gaji dulu, lalu coba */rekap gaji*.'
      : 'No income transaction categorized as *Gaji* was found. Record salary first, then try */summary salary*.';
    return reply;
  }

  const { from, to } = periodResult;
  let report: FinanceSummary;
  try {
    report = await getFinanceSummary(account.id, from, to);
  } catch {
    throw new BotWriteError('dependency');
  }

  const expense = cents(report.expense);
  const net = cents(report.net);
  const topCategories = report.categories
    .map((category) => ({
      name: category.id === null ? t[lang].uncategorized : category.name,
      amount: cents(category.amount),
    }))
    .sort((a, b) => a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0)
    .slice(0, 5);
  const netStr = (net >= 0n ? '+' : '-') + 'Rp' + formatIDR(formatCents(net));

  const catLines =
    topCategories.length > 0
      ? '\n\n' +
        (lang === 'id' ? '🔺 *Top Pengeluaran:*' : '🔺 *Top Expenses:*') +
        '\n' +
        topCategories
          .map((category, index) => {
            const percentage = expense > 0n
              ? ((category.amount * 100n + expense / 2n) / expense).toString()
              : '0';
            return `${index + 1}. ${category.name} - Rp${formatIDR(formatCents(category.amount))} (${percentage}%)`;
          })
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
        formatIDR(report.income) +
        '\n' +
        '💸 Pengeluaran: -Rp' +
        formatIDR(report.expense) +
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
        formatIDR(report.income) +
        '\n' +
        '💸 Expense : -Rp' +
        formatIDR(report.expense) +
        '\n' +
        '🏦 Balance : ' +
        netStr +
        catLines +
        (dashUrl ? '\n\n📱 Dashboard: ' + dashUrl : '');

  return reply;
}
