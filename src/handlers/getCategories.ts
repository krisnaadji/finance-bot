import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { Lang } from '../utils/lang';
import { Account, IncomingMessage } from '../ai/types';
import { BotWriteError } from './transactionData';
import { categoryColumns, categoryPath, decodeCategory, selectableCategories } from '../categories';

export async function getCategories(
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  return sendWA(msg.chatId, await categoriesReply(account, lang));
}

export async function categoriesReply(account: Account, lang: Lang): Promise<string> {
  const { data: cats, error } = await supabase
    .from('categories')
    .select(categoryColumns)
    .eq('account_id', account.id)
    .order('type')
    .order('sort_order');
  if (error || !Array.isArray(cats)) throw new BotWriteError('dependency');

  const rows=cats.map(c=>decodeCategory(c,account.id));
  const income=selectableCategories(rows,'income').map(c=>'  • '+categoryPath(c,rows,lang));
  const expense=selectableCategories(rows,'expense').map(c=>'  • '+categoryPath(c,rows,lang));

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

  return reply;
}
