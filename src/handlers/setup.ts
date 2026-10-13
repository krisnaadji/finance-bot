import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { t } from '../i18n/bot';
import { SUPPORTED_LANGS, type Lang } from '../utils/lang';
import type { IncomingMessage } from '../ai/types';
import { isRecord, isUuid } from '../utils/financialValidation';
import { BotDeliveryError, BotWriteError } from './transactionData';
export async function setup(msg: IncomingMessage, code: string, langArg?: string) {
  if (!code) return sendWA(msg.chatId, 'Format: /setup KODE  or  /setup KODE en');
  const lang: Lang = SUPPORTED_LANGS.includes(langArg as Lang) ? langArg as Lang : 'id';
  const found = await supabase.from('link_codes').select('*,accounts(*)').eq('code', code.toUpperCase())
    .eq('used', false).gt('expires_at', new Date().toISOString()).maybeSingle();
  if (found.error) throw new BotWriteError('dependency');
  if (!found.data) return sendWA(msg.chatId, t[lang].setupBadCode(process.env.DASHBOARD_URL ?? ''));
  const link: unknown = found.data;
  if (!isRecord(link) || !isUuid(link.id) || !isUuid(link.account_id) || !isRecord(link.accounts) ||
      link.accounts.id !== link.account_id) throw new BotWriteError('dependency');
  if (link.accounts.is_active !== true) throw new BotWriteError('inactive');
  const account = await supabase.from('accounts').update({ wa_chat_id: msg.chatId, language: lang })
    .eq('id', link.account_id).eq('is_active', true).select('id,name,wa_chat_id,language').maybeSingle();
  if (account.error) throw new BotWriteError('dependency');
  if (!account.data || account.data.id !== link.account_id || account.data.wa_chat_id !== msg.chatId ||
      account.data.language !== lang || typeof account.data.name !== 'string') throw new BotWriteError('missing');
  const consumed = await supabase.from('link_codes').update({ used: true }).eq('id', link.id).eq('account_id', link.account_id)
    .eq('used', false).gt('expires_at', new Date().toISOString()).select('id,used').maybeSingle();
  if (consumed.error) throw new BotWriteError('dependency');
  if (!consumed.data || consumed.data.id !== link.id || consumed.data.used !== true) throw new BotWriteError('conflict');
  const existing = await supabase.from('members').select('id').eq('account_id', link.account_id).eq('wa_phone', msg.rawFrom).maybeSingle();
  if (existing.error) throw new BotWriteError('dependency');
  if (existing.data && !isUuid(existing.data.id)) throw new BotWriteError('dependency');
  if (!existing.data) {
    const member = await supabase.from('members').insert({ account_id: link.account_id, wa_phone: msg.rawFrom, role: 'member' }).select('id').single();
    if (member.error) throw new BotWriteError('dependency');
    if (!member.data || !isUuid(member.data.id)) throw new BotWriteError('missing');
  } else {
    const member = await supabase.from('members').update({ wa_phone: msg.rawFrom }).eq('id', existing.data.id)
      .eq('account_id', link.account_id).eq('wa_phone', msg.rawFrom).select('id').maybeSingle();
    if (member.error) throw new BotWriteError('dependency');
    if (!member.data || member.data.id !== existing.data.id) throw new BotWriteError('missing');
  }
  try { return await sendWA(msg.chatId, t[lang].setupOk(account.data.name)); }
  catch { throw new BotDeliveryError(); }
}
