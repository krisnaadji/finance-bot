import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { formatIDR, formatDate, isYes } from '../utils/format';
import { Lang } from '../utils/lang';
import { t } from '../i18n/bot';
import {
  Account,
  IncomingMessage,
  PendingAction,
  TxnForBot,
} from '../ai/types';

export async function deleteTxn(
  txn: TxnForBot,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  await supabase.from('pending_actions').delete().eq('account_id', account.id);
  await supabase.from('pending_actions').insert({
    account_id: account.id,
    transaction_id: txn.id,
    action: 'DELETE',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  await sendWA(
    msg.chatId,
    t[lang].deleteConfirm(
      txn.description,
      formatIDR(txn.amount),
      txn.category_name ?? '-',
      formatDate(txn.date, lang),
    ),
  );
}

export async function confirmDelete(
  msg: IncomingMessage,
  pending: PendingAction,
  lang: Lang,
) {
  await supabase.from('pending_actions').delete().eq('id', pending.id);
  if (isYes(msg.text)) {
    await supabase
      .from('transactions')
      .delete()
      .eq('id', pending.transaction_id);
    await sendWA(msg.chatId, t[lang].txnDeleted);
  } else {
    await sendWA(msg.chatId, t[lang].txnDeleteCancel);
  }
}
