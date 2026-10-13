import { randomUUID } from 'node:crypto';

import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { formatIDR, formatDate, isYes, isYesNo } from '../utils/format';
import type { Lang } from '../utils/lang';
import { t } from '../i18n/bot';
import type { Account, IncomingMessage, PendingAction, TxnForBot, DeleteConfirmationOutcome } from '../ai/types';
import { isRecord, isUuid } from '../utils/financialValidation';
import { BotDeliveryError, BotWriteError, canonicalTxn, categoryName, loadWriteContext, transactionColumns } from './transactionData';
export async function deleteTxn(txn: TxnForBot, account: Account, msg: IncomingMessage, lang: Lang): Promise<void> {
  if (process.env.DELETE_CONFIRMATIONS_ENABLED !== 'true') {
    await sendWA(msg.chatId, t[lang].confirmationUnsupported); return;
  }
  if (!isUuid(txn.id)) throw new BotWriteError('invalid');
  const { categories } = await loadWriteContext(account, msg);
  const target = await supabase.from('transactions').select(transactionColumns).eq('id', txn.id).eq('account_id', account.id).maybeSingle();
  if (target.error) throw new BotWriteError('dependency');
  if (!target.data) throw new BotWriteError('missing');
  const saved = canonicalTxn(target.data, account.id);
  const pendingId = randomUUID();
  const pending = await supabase.from('pending_actions').upsert({ id: pendingId, account_id: account.id,
    transaction_id: saved.id, action: 'DELETE', expires_at: new Date(Date.now() + 60_000).toISOString(),
    requested_by_phone: msg.rawFrom, wa_chat_id: msg.chatId, confirmation_message_id: null },
    { onConflict: 'account_id,wa_chat_id,requested_by_phone' }).select('id').single();
  if (pending.error) throw new BotWriteError('dependency');
  if (!isRecord(pending.data) || pending.data.id !== pendingId) throw new BotWriteError('missing');
  let confirmationId: string;
  try {
    confirmationId = await sendWA(msg.chatId, t[lang].deleteConfirm(saved.description, formatIDR(saved.amount),
      categoryName(saved, categories, lang), formatDate(saved.date, lang)));
  } catch { throw new BotDeliveryError(); }
  if (typeof confirmationId !== 'string' || !confirmationId.trim()) {
    // Initial row remains null-bound and therefore cannot be consumed. No guessed gateway fallback.
    await sendWA(msg.chatId, t[lang].confirmationUnsupported);
    return;
  }
  const bound = await supabase.from('pending_actions').update({ confirmation_message_id: confirmationId })
    .eq('id', pendingId).eq('account_id', account.id).eq('wa_chat_id', msg.chatId).eq('requested_by_phone', msg.rawFrom)
    .select('id,confirmation_message_id').maybeSingle();
  if (bound.error) throw new BotWriteError('dependency');
  if (!isRecord(bound.data) || bound.data.id !== pendingId || bound.data.confirmation_message_id !== confirmationId) throw new BotWriteError('missing');
}
export async function confirmDelete(msg: IncomingMessage, pending: PendingAction, account: Account, lang: Lang): Promise<void> {
  if (process.env.DELETE_CONFIRMATIONS_ENABLED !== 'true') {
    await sendWA(msg.chatId, t[lang].confirmationUnsupported); return;
  }
  if (!isUuid(pending.id) || pending.account_id !== account.id || pending.action !== 'DELETE' ||
      !pending.confirmation_message_id || msg.repliedToId !== pending.confirmation_message_id ||
      pending.requested_by_phone !== msg.rawFrom || pending.wa_chat_id !== msg.chatId || !isYesNo(msg.text)) {
    await sendWA(msg.chatId, t[lang].confirmationUnsupported); return;
  }
  const result = await supabase.rpc('consume_delete_confirmation', {
    p_pending_id: pending.id, p_account_id: account.id, p_chat_id: msg.chatId,
    p_requester_phone: msg.rawFrom, p_confirmation_message_id: msg.repliedToId,
    p_decision: isYes(msg.text) ? 'confirm' : 'cancel',
  });
  if (result.error) throw new BotWriteError('dependency');
  const outcomes: DeleteConfirmationOutcome[] = ['deleted', 'cancelled', 'expired', 'already_consumed', 'target_missing', 'forbidden'];
  if (typeof result.data !== 'string' || !outcomes.includes(result.data as DeleteConfirmationOutcome)) throw new BotWriteError('dependency');
  const outcome = result.data as DeleteConfirmationOutcome;
  const reply = outcome === 'deleted' ? t[lang].txnDeleted : outcome === 'cancelled' ? t[lang].txnDeleteCancel :
    outcome === 'expired' ? t[lang].confirmationExpired : outcome === 'target_missing' ? t[lang].resourceMissing : t[lang].confirmationHandled;
  try { await sendWA(msg.chatId, reply); } catch { throw new BotDeliveryError(); }
}
