import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { Lang } from '../utils/lang';
import { Account, IncomingMessage } from '../ai/types';

export async function getCategories(
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  const { data: cats } = await supabase
    .from('categories')
    .select('name, type')
    .eq('account_id', account.id)
    .eq('is_active', true)
    .order('type')
    .order('sort_order');

  const income = (cats ?? [])
    .filter((c) => c.type === 'income')
    .map((c) => '  • ' + c.name);
  const expense = (cats ?? [])
    .filter((c) => c.type === 'expense')
    .map((c) => '  • ' + c.name);

  const reply =
    lang === 'id'
      ? '🏷 *Kategori Pemasukan:*\n' +
        income.join('\n') +
        '\n\n🏷 *Kategori Pengeluaran:*\n' +
        expense.join('\n')
      : '🏷 *Income Categories:*\n' +
        income.join('\n') +
        '\n\n🏷 *Expense Categories:*\n' +
        expense.join('\n');

  await sendWA(msg.chatId, reply);
}
