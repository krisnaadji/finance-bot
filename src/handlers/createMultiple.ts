import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { formatIDR } from '../utils/format';
import { AIResponse, Account, IncomingMessage } from '../ai/types';
import { Lang } from '../utils/lang';

export async function createMultiple(
  ai: AIResponse,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  const items = ai.transactions ?? [];
  if (!items.length) {
    return sendWA(
      msg.chatId,
      lang === 'id'
        ? 'Tidak ada transaksi yang ditemukan.'
        : 'No transactions found.',
    );
  }

  // Resolve category names → IDs
  const { data: cats } = await supabase
    .from('categories')
    .select('id, name')
    .eq('account_id', account.id);
  const catMap: Record<string, string> = {};
  for (const c of cats ?? []) catMap[c.name] = c.id;

  const rows = items.map((p) => ({
    account_id: account.id,
    amount: Number(p.amount ?? 0),
    type: p.type ?? 'expense',
    description: p.description ?? '',
    date: p.date ?? new Date().toISOString().split('T')[0],
    category_id: p.category ? (catMap[p.category] ?? null) : null,
    wa_message_id: msg.messageId,
  }));

  await supabase.from('transactions').insert(rows);

  // Build reply
  const lines = items.map(
    (p) =>
      (p.type === 'income' ? '💰' : '💸') +
      ' ' +
      (p.description ?? '') +
      ' — ' +
      (p.type === 'income' ? '+' : '-') +
      'Rp' +
      formatIDR(Number(p.amount ?? 0)),
  );
  const total = items.reduce(
    (s, p) =>
      s +
      (p.type === 'expense' ? Number(p.amount ?? 0) : -Number(p.amount ?? 0)),
    0,
  );
  const totalStr = (total >= 0 ? '-' : '+') + 'Rp' + formatIDR(Math.abs(total));

  const reply =
    lang === 'id'
      ? '✅ *' +
        items.length +
        ' transaksi tercatat!*\n\n' +
        lines.join('\n') +
        '\n\n🏦 Total: ' +
        totalStr
      : '✅ *' +
        items.length +
        ' transactions recorded!*\n\n' +
        lines.join('\n') +
        '\n\n🏦 Total: ' +
        totalStr;

  await sendWA(msg.chatId, reply);
}
