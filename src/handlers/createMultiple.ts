import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { formatIDR, formatDate } from '../utils/format';
import { AIResponse, Account, IncomingMessage } from '../ai/types';
import { Lang } from '../utils/lang';
import { t } from '../i18n/bot';

export async function createMultiple(
  ai: AIResponse,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  const items = ai.transactions ?? [];
  if (!items.length)
    return sendWA(
      msg.chatId,
      lang === 'id' ? 'Tidak ada transaksi.' : 'No transactions found.',
    );

  // Resolve category names → IDs
  const { data: cats } = await supabase
    .from('categories')
    .select('id, name')
    .eq('account_id', account.id);
  const catMap: Record<string, string> = {};
  for (const c of cats ?? []) catMap[c.name] = c.id;

  // Look up member name by phone for attribution
  const { data: member } = await supabase
    .from('members')
    .select('display_name')
    .eq('account_id', account.id)
    .eq('wa_phone', msg.rawFrom)
    .single();

  // Insert all transactions sequentially
  const rows = items.map((p) => ({
    account_id: account.id,
    amount: Number(p.amount ?? 0),
    type: p.type ?? 'expense',
    description: p.description ?? '',
    date: p.date ?? new Date().toISOString().split('T')[0],
    category_id: p.category ? (catMap[p.category] ?? null) : null,
    raw_message: msg.text,
    wa_user_message_id: msg.messageId,
    recorded_by_name: member?.display_name ?? msg.rawFrom,
    recorded_by_phone: msg.rawFrom,
  }));

  const inserted: any[] = [];
  for (const row of rows) {
    const { data, error } = await supabase
      .from('transactions')
      .insert(row)
      .select()
      .single();

    if (error || !data) {
      if (inserted.length > 0) {
        await supabase
          .from('transactions')
          .delete()
          .in(
            'id',
            inserted.map((r) => r.id),
          );
      }
      await sendWA(
        msg.chatId,
        lang === 'id'
          ? '❌ Gagal menyimpan transaksi.'
          : '❌ Failed to save transactions.',
      );
      return;
    }
    inserted.push(data);
  }

  // Build reply lines
  const lines = items.map((p, i) => {
    const emoji = p.type === 'income' ? '💰' : '💸';
    const typeStr =
      p.type === 'income'
        ? lang === 'id'
          ? 'Pemasukan'
          : 'Income'
        : lang === 'id'
          ? 'Pengeluaran'
          : 'Expense';
    const cat = p.category ?? (lang === 'id' ? 'Lainnya' : 'Other');
    const amt =
      (p.type === 'income' ? '+' : '-') +
      'Rp' +
      formatIDR(Number(p.amount ?? 0));
    const date = formatDate(
      p.date ?? new Date().toISOString().split('T')[0],
      lang,
    );
    return (
      i +
      1 +
      '. ' +
      emoji +
      ' ' +
      (p.description ?? '') +
      '\n' +
      '   ' +
      amt +
      ' · ' +
      cat +
      ' · ' +
      typeStr +
      ' · ' +
      date
    );
  });

  const total = items.reduce(
    (s, p) =>
      s +
      (p.type === 'expense' ? Number(p.amount ?? 0) : -Number(p.amount ?? 0)),
    0,
  );
  const totalStr = (total >= 0 ? '-' : '+') + 'Rp' + formatIDR(Math.abs(total));

  // Check budget warnings for all expense items
  const now = new Date();
  const fromDate = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split('T')[0];
  const toDate = now.toISOString().split('T')[0];
  const warnings: string[] = [];

  // Get all budgets for this account at once
  const { data: budgets } = await supabase
    .from('budgets')
    .select('category_id, amount')
    .eq('account_id', account.id);

  if (budgets?.length) {
    // Get all category IDs that have budgets and appear in this batch
    const budgetMap: Record<string, number> = {};
    for (const b of budgets) budgetMap[b.category_id] = b.amount;

    // Get affected category IDs from this batch
    const expenseCatIds = items
      .filter((p) => p.type === 'expense' && p.category && catMap[p.category])
      .map((p) => catMap[p.category!])
      .filter((id) => budgetMap[id]);

    const uniqueCatIds = [...new Set(expenseCatIds)];

    for (const catId of uniqueCatIds) {
      const { data: spendRows } = await supabase
        .from('transactions')
        .select('amount')
        .eq('account_id', account.id)
        .eq('category_id', catId)
        .eq('type', 'expense')
        .gte('date', fromDate)
        .lte('date', toDate);

      const totalSpent = (spendRows ?? []).reduce(
        (s, r) => s + Number(r.amount),
        0,
      );
      const budgetLimit = budgetMap[catId];
      const pct = Math.round((totalSpent / budgetLimit) * 100);
      const catName =
        Object.entries(catMap).find(([, id]) => id === catId)?.[0] ?? '';

      if (totalSpent > budgetLimit) {
        warnings.push(
          lang === 'id'
            ? `⚠️ *Budget ${catName} terlampaui!* Rp${formatIDR(totalSpent)} / Rp${formatIDR(budgetLimit)} (${pct}%)`
            : `⚠️ *${catName} budget exceeded!* Rp${formatIDR(totalSpent)} / Rp${formatIDR(budgetLimit)} (${pct}%)`,
        );
      } else if (pct >= 80) {
        warnings.push(
          lang === 'id'
            ? `⚠️ Budget ${catName}: Rp${formatIDR(totalSpent)} / Rp${formatIDR(budgetLimit)} (${pct}%)`
            : `⚠️ ${catName} budget: Rp${formatIDR(totalSpent)} / Rp${formatIDR(budgetLimit)} (${pct}%)`,
        );
      }
    }
  }

  const header =
    lang === 'id'
      ? '✅ *' + items.length + ' transaksi tercatat!*'
      : '✅ *' + items.length + ' transactions recorded!*';

  const footer =
    '\n\n🏦 ' +
    (lang === 'id' ? 'Total' : 'Total') +
    ': ' +
    totalStr +
    '\n\n' +
    (lang === 'id'
      ? '_Balas pesan ini untuk edit atau hapus_'
      : '_Reply to edit or delete a transaction_') +
    (warnings.length > 0 ? '\n\n' + warnings.join('\n') : '');

  const reply = header + '\n\n' + lines.join('\n\n') + footer;
  const botMessageId = await sendWA(msg.chatId, reply);

  if (botMessageId) {
    const ids = inserted.map((r) => r.id);
    await supabase
      .from('transactions')
      .update({ wa_bot_message_id: botMessageId })
      .in('id', ids);
  }
}
