import { supabase } from '../services/supabase';
import type { AIResponse, Account, IncomingMessage } from '../ai/types';
import type { Lang } from '../utils/lang';
import { validateAIResponse, InvalidAICommand } from '../ai/validation';
import { BotWriteError, budgetWarnings, canonicalTxn, classificationCategory, deliverTransactionReceipt, loadWriteContext, transactionColumns, transactionReceipt } from './transactionData';
export async function createTxn(ai: AIResponse, account: Account, msg: IncomingMessage, lang: Lang): Promise<void> {
  const command = validateAIResponse(ai);
  if (command.action !== 'CREATE_TRANSACTION') throw new InvalidAICommand();
  const p = command.payload;
  const { categories, displayName } = await loadWriteContext(account, msg);
  const category = classificationCategory(p.category_id, p.type!, categories);
  const result = await supabase.from('transactions').insert({ account_id: account.id, category_id: category?.id ?? null,
    amount: p.amount!, type: p.type!, description: p.description ?? '', date: p.date!, raw_message: msg.text,
    wa_user_message_id: msg.messageId, recorded_by_name: displayName, recorded_by_phone: msg.rawFrom })
    .select(transactionColumns).single();
  if (result.error) throw new BotWriteError('dependency');
  if (!result.data) throw new BotWriteError('missing');
  const txn = canonicalTxn(result.data, account.id);
  const warnings = await budgetWarnings([txn], categories, account.id, lang);
  await deliverTransactionReceipt([txn], account, msg, transactionReceipt(txn, categories, lang) + warnings);
}
