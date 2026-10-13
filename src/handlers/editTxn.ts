import { supabase } from '../services/supabase';
import type { AIResponse, Account, IncomingMessage } from '../ai/types';
import type { Lang } from '../utils/lang';
import { isBusinessDate, isUuid, parseAmount } from '../utils/financialValidation';
import { InvalidAICommand, validateAIResponse } from '../ai/validation';
import { BotWriteError, canonicalTxn, deliverTransactionReceipt, loadWriteContext, resolveCategory, transactionColumns, transactionReceipt } from './transactionData';
import type { CanonicalTxn } from './transactionData';
type EditPatch = Partial<Pick<CanonicalTxn, 'amount' | 'type' | 'date' | 'description' | 'category_id'>> & {
  edited_by_name: string; updated_at: string;
};
export async function editTxn(ai: AIResponse, txnId: string, account: Account, msg: IncomingMessage, lang: Lang): Promise<void> {
  const command = validateAIResponse(ai);
  if (!['EDIT_TRANSACTION', 'EDIT_FROM_MULTIPLE'].includes(command.action) || !isUuid(txnId)) throw new InvalidAICommand();
  const p = command.payload;
  const { categories, displayName } = await loadWriteContext(account, msg);
  const before = await supabase.from('transactions').select(transactionColumns).eq('id', txnId).eq('account_id', account.id).maybeSingle();
  if (before.error) throw new BotWriteError('dependency');
  if (!before.data) throw new BotWriteError('missing');
  const existing = canonicalTxn(before.data, account.id);
  const next = { ...existing, amount: p.amount ?? existing.amount, type: p.type ?? existing.type,
    date: p.date ?? existing.date, description: p.description ?? existing.description };
  if (parseAmount(next.amount) === null || !isBusinessDate(next.date)) throw new InvalidAICommand();
  if (Object.hasOwn(p, 'category')) next.category_id = resolveCategory(p.category, next.type, categories)?.id ?? null;
  if (next.category_id !== null) {
    const cat = categories.find((row) => row.id === next.category_id);
    const retainingHistory = !Object.hasOwn(p, 'category') && !Object.hasOwn(p, 'type');
    if (!cat || cat.account_id !== account.id || cat.type !== next.type || (!cat.is_active && !retainingHistory)) throw new BotWriteError('invalid');
  }
  const patch: EditPatch = { edited_by_name: displayName, updated_at: new Date().toISOString() };
  if (Object.hasOwn(p, 'amount')) patch.amount = next.amount;
  if (Object.hasOwn(p, 'type')) patch.type = next.type;
  if (Object.hasOwn(p, 'date')) patch.date = next.date;
  if (Object.hasOwn(p, 'description')) patch.description = next.description;
  if (Object.hasOwn(p, 'category')) patch.category_id = next.category_id;
  let update = supabase.from('transactions').update(patch)
    .eq('id', txnId).eq('account_id', account.id).eq('amount', existing.amount)
    .eq('type', existing.type).eq('date', existing.date).eq('description', existing.description);
  update = existing.category_id === null
    ? update.is('category_id', null) : update.eq('category_id', existing.category_id);
  const result = await update.select(transactionColumns).maybeSingle();
  if (result.error) throw new BotWriteError('dependency');
  if (!result.data) throw new BotWriteError('conflict');
  const saved = canonicalTxn(result.data, account.id);
  await deliverTransactionReceipt([saved], account, msg, transactionReceipt(saved, categories, lang, true));
}
