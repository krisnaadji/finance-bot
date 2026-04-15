import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { formatIDR, formatDate } from '../utils/format';
import { Lang } from '../utils/lang';
import { Account, IncomingMessage } from '../ai/types';

export async function searchTxn(
  query: string,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  if (!query.trim()) {
    await sendWA(
      msg.chatId,
      lang === 'id' ? '🔍 Contoh: /cari netflix' : '🔍 Example: /cari netflix',
    );
    return;
  }

  const { data } = await supabase
    .from('transactions')
    .select('*, categories(name)')
    .eq('account_id', account.id)
    .ilike('description', `%${query}%`)
    .order('date', { ascending: false })
    .limit(10);

  const rows = data ?? [];

  if (!rows.length) {
    await sendWA(
      msg.chatId,
      lang === 'id'
        ? `🔍 Tidak ada transaksi yang cocok dengan *"${query}"*`
        : `🔍 No transactions found for *"${query}"*`,
    );
    return;
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

  await sendWA(msg.chatId, header + lines.join('\n'));
}
