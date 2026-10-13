import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import type { AIResponse, Account, IncomingMessage } from '../ai/types';
import type { Lang } from '../utils/lang';
import { validateAIResponse, InvalidAICommand } from '../ai/validation';
import { t } from '../i18n/bot';
import { formatIDR } from '../utils/format';
import { BotDeliveryError, BotWriteError, budgetWarnings, canonicalTxn, deliverTransactionReceipt, loadWriteContext, resolveCategory, transactionColumns, transactionReceipt, type CanonicalTxn } from './transactionData';
export async function createMultiple(ai: AIResponse, account: Account, msg: IncomingMessage, lang: Lang): Promise<void> {
  const command = validateAIResponse(ai);
  if (command.action !== 'CREATE_MULTIPLE' || !command.transactions) throw new InvalidAICommand();
  const { categories, displayName } = await loadWriteContext(account, msg);
  const rows = command.transactions.map((p) => ({ account_id: account.id,
    category_id: resolveCategory(p.category, p.type!, categories)?.id ?? null, amount: p.amount!, type: p.type!,
    description: p.description ?? '', date: p.date!, raw_message: msg.text, wa_user_message_id: msg.messageId,
    recorded_by_name: displayName, recorded_by_phone: msg.rawFrom }));
  const inserted: CanonicalTxn[] = [];
  for (const row of rows) {
    const result = await supabase.from('transactions').insert(row).select(transactionColumns).single();
    if (result.error || !result.data) {
      if (inserted.length) {
        const ids = inserted.map((txn) => txn.id);
        const undone = await supabase.from('transactions').delete().eq('account_id', account.id).in('id', ids).select('id');
        if (undone.error || !Array.isArray(undone.data) || undone.data.length !== ids.length || !ids.every((id) => undone.data.some((txn) => txn.id === id))) {
          // A failed compensation may have partially removed rows. Re-read only this request's known committed IDs.
          const remaining = await supabase.from('transactions').select(transactionColumns).eq('account_id', account.id).in('id', ids);
          if (remaining.error || !Array.isArray(remaining.data)) {
            try { await sendWA(msg.chatId, t[lang].batchOutcomeUnknown); } catch { throw new BotDeliveryError(); }
            return;
          }
          const persisted = remaining.data.map((txn) => canonicalTxn(txn, account.id));
          if (persisted.length) {
            await deliverTransactionReceipt(persisted, account, msg,
              t[lang].batchPartial + '\n\n' + persisted.map((txn, i) => `${i + 1}. ${transactionReceipt(txn, categories, lang)}`).join('\n\n'));
            return;
          }
        }
      }
      throw new BotWriteError('dependency');
    }
    inserted.push(canonicalTxn(result.data, account.id));
  }
  // Exact decimal receipt total; do not introduce floating-point rounding into receipt formatting.
  const cents = inserted.reduce((sum, txn) => {
    const [whole, fraction] = txn.amount.split('.');
    const amount = BigInt(whole) * 100n + BigInt(fraction);
    return sum + (txn.type === 'expense' ? amount : -amount);
  }, 0n);
  const absolute = cents < 0n ? -cents : cents;
  const total = `${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
  const header = lang === 'id' ? `✅ *${inserted.length} transaksi tercatat!*` : `✅ *${inserted.length} transactions recorded!*`;
  const lines = inserted.map((txn, i) => `${i + 1}. ${transactionReceipt(txn, categories, lang)}`);
  const warnings = await budgetWarnings(inserted, categories, account.id, lang);
  const footer = `\n\n🏦 Total: ${cents >= 0n ? '-' : '+'}Rp${formatIDR(total)}`;
  await deliverTransactionReceipt(inserted, account, msg, header + '\n\n' + lines.join('\n\n') + footer + warnings);
}
