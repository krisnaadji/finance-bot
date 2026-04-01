import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { Lang } from '../utils/lang';
import { AIResponse, Account, IncomingMessage } from '../ai/types';

export async function addCategory(
  ai: AIResponse,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  const name = ai.payload.category_name?.trim();
  const type = ai.payload.category_type;

  if (!name || !type) {
    await sendWA(
      msg.chatId,
      lang === 'id'
        ? '❌ Format: tambah kategori pengeluaran NamaKategori'
        : '❌ Format: add expense category CategoryName',
    );
    return;
  }

  const { data: existing } = await supabase
    .from('categories')
    .select('id')
    .eq('account_id', account.id)
    .ilike('name', name)
    .single();

  if (existing) {
    await sendWA(
      msg.chatId,
      lang === 'id'
        ? '⚠️ Kategori ' + name + ' sudah ada.'
        : '⚠️ Category ' + name + ' already exists.',
    );
    return;
  }

  await supabase.from('categories').insert({
    account_id: account.id,
    name,
    type,
    is_custom: true,
    is_active: true,
  });

  await sendWA(
    msg.chatId,
    lang === 'id'
      ? '✅ Kategori *' +
          name +
          '* berhasil ditambahkan sebagai kategori ' +
          (type === 'income' ? 'pemasukan' : 'pengeluaran') +
          '.'
      : '✅ Category *' + name + '* added as an ' + type + ' category.',
  );
}
