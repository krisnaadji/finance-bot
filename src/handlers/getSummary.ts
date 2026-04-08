import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { formatIDR } from '../utils/format';
import { Lang } from '../utils/lang';
import { AIResponse, Account, IncomingMessage } from '../ai/types';

function getPeriodDates(period: string): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  if (period === 'last_month') {
    return {
      from: new Date(y, m - 1, 1).toISOString().split('T')[0],
      to: new Date(y, m, 0).toISOString().split('T')[0],
    };
  }
  if (period === 'this_week') {
    const day = now.getDay() || 7;
    const mon = new Date(now);
    mon.setDate(now.getDate() - day + 1);
    return {
      from: mon.toISOString().split('T')[0],
      to: now.toISOString().split('T')[0],
    };
  }
  return {
    from: new Date(y, m, 1).toISOString().split('T')[0],
    to: now.toISOString().split('T')[0],
  };
}

export async function getSummary(
  ai: AIResponse,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  const period = ai.payload.period || 'this_month';
  const { from, to } = getPeriodDates(period);

  const { data: txns } = await supabase
    .from('transactions')
    .select('amount, type, categories(name)')
    .eq('account_id', account.id)
    .gte('date', from)
    .lte('date', to);

  const rows = txns ?? [];
  const income = rows
    .filter((t) => t.type === 'income')
    .reduce((s, t) => s + Number(t.amount), 0);
  const expense = rows
    .filter((t) => t.type === 'expense')
    .reduce((s, t) => s + Number(t.amount), 0);
  const net = income - expense;

  const byCategory: Record<string, number> = {};
  for (const txn of rows.filter((t) => t.type === 'expense')) {
    const name = (txn.categories as any)?.name ?? 'Lainnya';
    byCategory[name] = (byCategory[name] ?? 0) + Number(txn.amount);
  }
  const top = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];
  const netStr = (net >= 0 ? '+' : '-') + 'Rp' + formatIDR(Math.abs(net));

  const dashUrl = process.env.DASHBOARD_URL ?? '';
  const reply =
    lang === 'id'
      ? '📊 *Ringkasan ' +
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
        (top
          ? '\n\n🔺 Pengeluaran terbesar: ' +
            top[0] +
            ' (Rp' +
            formatIDR(top[1]) +
            ')'
          : '') +
        (dashUrl ? '\n\n📱 Dashboard: ' + dashUrl : '')
      : '📊 *Summary ' +
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
        (top
          ? '\n\n🔺 Top expense: ' + top[0] + ' (Rp' + formatIDR(top[1]) + ')'
          : '') +
        (dashUrl ? '\n\n📱 Dashboard: ' + dashUrl : '');

  await sendWA(msg.chatId, reply);
}
