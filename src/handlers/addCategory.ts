import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import type { AIResponse, Account, IncomingMessage } from '../ai/types';
import type { Lang } from '../utils/lang';
import { isRecord, isUuid } from '../utils/financialValidation';
import { InvalidAICommand, validateAIResponse } from '../ai/validation';
import { BotDeliveryError, BotWriteError, assertActiveLinkedAccount } from './transactionData';
import { t } from '../i18n/bot';
export async function addCategory(ai: AIResponse, account: Account, msg: IncomingMessage, lang: Lang): Promise<void> {
  const command = validateAIResponse(ai);
  if (command.action !== 'ADD_CATEGORY') throw new InvalidAICommand();
  const name = command.payload.category_name!;
  const type = command.payload.category_type!;
  await assertActiveLinkedAccount(account, msg);
  const existing = await supabase.from('categories').select('id,name').eq('account_id', account.id);
  if (existing.error || !Array.isArray(existing.data)) throw new BotWriteError('dependency');
  if (existing.data.some((cat) => String(cat.name).trim().toLowerCase() === name.toLowerCase())) throw new BotWriteError('conflict');
  const result = await supabase.from('categories').insert({ account_id: account.id, name, type, is_custom: true, is_active: true })
    .select('id,account_id,name,type').single();
  if (result.error) throw new BotWriteError(result.error.code === '23505' ? 'conflict' : 'dependency');
  const saved: unknown = result.data;
  if (!isRecord(saved) || !isUuid(saved.id) || saved.account_id !== account.id || typeof saved.name !== 'string' ||
      (saved.type !== 'income' && saved.type !== 'expense')) throw new BotWriteError('missing');
  try {
    const delivery = await sendWA(msg.chatId, t[lang].categoryAdded(saved.name, saved.type));
    if (delivery.kind !== 'accepted') throw new BotDeliveryError();
  } catch {
    throw new BotDeliveryError();
  }
}
