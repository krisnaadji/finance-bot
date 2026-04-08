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

  // Insert all transactions
  const rows = items.map((p) => ({
    account_id: account.id,
    amount: Number(p.amount ?? 0),
    type: p.type ?? 'expense',
    description: p.description ?? '',
    date: p.date ?? new Date().toISOString().split('T')[0],
    category_id: p.category ? (catMap[p.category] ?? null) : null,
    raw_message: msg.text,
    wa_user_message_id: msg.messageId,
  }));

  const { data: inserted, error } = await supabase
    .from('transactions')
    .insert(rows)
    .select();

  if (error || !inserted?.length) {
    await sendWA(
      msg.chatId,
      lang === 'id'
        ? '❌ Gagal menyimpan transaksi.'
        : '❌ Failed to save transactions.',
    );
    return;
  }

  // Build informative reply with number, description, category, type, amount
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
      : '_Reply to edit or delete a transaction_');

  const reply = header + '\n\n' + lines.join('\n\n') + footer;
  const botMessageId = await sendWA(msg.chatId, reply);

  // Store bot message ID on every inserted transaction so reply-to-edit works
  if (botMessageId) {
    const ids = inserted.map((r) => r.id);
    await supabase
      .from('transactions')
      .update({ wa_bot_message_id: botMessageId })
      .in('id', ids);
  }
}
