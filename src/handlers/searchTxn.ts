import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { formatIDR, formatDate } from '../utils/format';
import { Lang } from '../utils/lang';
import { Account, IncomingMessage } from '../ai/types';
import { BotWriteError } from './transactionData';

export async function searchTxn(
  query: string,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  return sendWA(msg.chatId, await searchReply(query, account, lang));
}

export async function searchReply(query: string, account: Account, lang: Lang): Promise<string> {
  if (!query.trim()) {
    return lang === 'id' ? '🔍 Contoh: /cari netflix' : '🔍 Example: /cari netflix';
  }

  const { data, error } = await supabase
    .from('transactions')
    .select('*, categories(name)')
    .eq('account_id', account.id)
    .ilike('description', `%${query}%`)
    .order('date', { ascending: false })
    .limit(10);
  if (error || !Array.isArray(data)) throw new BotWriteError('dependency');

  const rows = data ?? [];

  if (!rows.length) {
    return lang === 'id'
      ? `🔍 Tidak ada transaksi yang cocok dengan *"${query}"*`
      : `🔍 No transactions found for *"${query}"*`;
  }

  const lines = rows.map((t) => {
    const sign = t.type === 'income' ? '+' : '-';
    const cat = (t.categories as any)?.name ?? '—';
    const amount = formatIDR(Number(t.amount));
    const date = formatDate(t.date, lang);
    return `${sign}Rp${amount} · ${t.description} · ${cat} · ${date}`;
  });

  const header =
    lang === 'id'
      ? `🔍 *Hasil pencarian "${query}":*\n`
      : `🔍 *Search results for "${query}":*\n`;

  return header + lines.join('\n');
}
