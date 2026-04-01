import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { Lang } from '../utils/lang';
import { t } from '../i18n/bot';
import { AIResponse, Account, IncomingMessage } from '../ai/types';

export async function editTxn(
  ai: AIResponse,
  txnId: string,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  const { payload } = ai;
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (payload.amount !== undefined) updates.amount = payload.amount;
  if (payload.type !== undefined) updates.type = payload.type;
  if (payload.date !== undefined) updates.date = payload.date;
  if (payload.description !== undefined)
    updates.description = payload.description;

  if (payload.category) {
    const { data: cat } = await supabase
      .from('categories')
      .select('id')
      .eq('account_id', account.id)
      .ilike('name', payload.category)
      .single();
    if (cat) updates.category_id = cat.id;
  }

  await supabase.from('transactions').update(updates).eq('id', txnId);
  await sendWA(msg.chatId, t[lang].txnEdited);
}
