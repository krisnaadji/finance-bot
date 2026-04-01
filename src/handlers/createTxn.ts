import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { formatIDR, formatDate } from '../utils/format';
import { Lang } from '../utils/lang';
import { t } from '../i18n/bot';
import { AIResponse, Account, IncomingMessage } from '../ai/types';

export async function createTxn(
  ai: AIResponse,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  // Resolve category_id from name
  const { data: cat } = await supabase
    .from('categories')
    .select('id')
    .eq('account_id', account.id)
    .ilike('name', ai.payload.category ?? '')
    .single();

  // Insert transaction without bot message ID yet
  const { data: txn, error } = await supabase
    .from('transactions')
    .insert({
      account_id: account.id,
      category_id: cat?.id ?? null,
      amount: ai.payload.amount,
      type: ai.payload.type,
      description: ai.payload.description,
      date: ai.payload.date,
      raw_message: msg.text,
      wa_user_message_id: msg.messageId,
    })
    .select()
    .single();

  if (error || !txn) {
    await sendWA(
      msg.chatId,
      lang === 'id'
        ? '❌ Gagal menyimpan transaksi.'
        : '❌ Failed to save transaction.',
    );
    return;
  }

  const reply = t[lang].txnCreated(
    ai.payload.description ?? '',
    formatIDR(ai.payload.amount ?? 0),
    ai.payload.category ?? '',
    formatDate(ai.payload.date ?? new Date().toISOString().split('T')[0], lang),
    ai.payload.type ?? 'expense',
  );

  const botMessageId = await sendWA(msg.chatId, reply);

  // Store bot message ID so reply-to-message can look up this transaction
  await supabase
    .from('transactions')
    .update({ wa_bot_message_id: botMessageId })
    .eq('id', txn.id);
}
