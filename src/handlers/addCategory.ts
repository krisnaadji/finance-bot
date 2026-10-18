import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import type { AIResponse, Account, IncomingMessage } from '../ai/types';
import type { Lang } from '../utils/lang';
import { InvalidAICommand, validateAIResponse } from '../ai/validation';
import { BotDeliveryError, BotWriteError, loadWriteContext } from './transactionData';
import { categoryColumns, categoryPath, decodeCategory, resolveCategoryId } from '../categories';
import { t } from '../i18n/bot';
export async function addCategory(ai: AIResponse, account: Account, msg: IncomingMessage, lang: Lang): Promise<void> {
  const command=validateAIResponse(ai);
  if (command.action !== 'ADD_CATEGORY') throw new InvalidAICommand();
  const p=command.payload, type=p.category_type!;
  const {categories}=await loadWriteContext(account,msg);
  const owner=await supabase.from('members').select('user_id').eq('account_id',account.id).eq('wa_phone',msg.rawFrom).maybeSingle();
  if (owner.error) throw new BotWriteError('dependency');
  if (owner.data?.user_id !== account.owner_id) throw new BotWriteError('invalid');
  const parentId=p.parent_category_id ?? null;
  if (parentId !== null) {
    let parent;
    try { parent=resolveCategoryId(parentId,type,categories); } catch { throw new BotWriteError('invalid'); }
    if (!parent || parent.parent_id !== null || parent.code === 'salary') throw new BotWriteError('invalid');
  }
  const nameId=p.category_language === 'id' ? p.category_name! : p.translated_name ?? null;
  const nameEn=p.category_language === 'en' ? p.category_name! : p.translated_name ?? null;
  const result=await supabase.from('categories').insert({account_id:account.id,name_id:nameId,name_en:nameEn,parent_id:parentId,type,is_custom:true,is_active:true})
    .select(categoryColumns).single();
  if (result.error) throw new BotWriteError(result.error.code === '23505' || result.error.code === '23514' ? 'conflict' : 'dependency');
  let saved;
  try { saved=decodeCategory(result.data,account.id); } catch { throw new BotWriteError('dependency'); }
  try {
    const delivery=await sendWA(msg.chatId,t[lang].categoryAdded(categoryPath(saved,[...categories,saved],lang),saved.type));
    if (delivery.kind !== 'accepted') throw new BotDeliveryError();
  } catch { throw new BotDeliveryError(); }
}
