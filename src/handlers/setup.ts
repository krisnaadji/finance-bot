import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import { t } from '../i18n/bot';
import { SUPPORTED_LANGS, Lang } from '../utils/lang';
import { IncomingMessage } from '../ai/types';

export async function setup(
  msg: IncomingMessage,
  code: string,
  langArg?: string,
) {
  if (!code)
    return sendWA(msg.chatId, 'Format: /setup KODE  or  /setup KODE en');

  const { data: linkCode } = await supabase
    .from('link_codes')
    .select('*, accounts(*)')
    .eq('code', code.toUpperCase())
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .single();

  const dashboardUrl = process.env.DASHBOARD_URL ?? '';
  if (!linkCode) return sendWA(msg.chatId, t['id'].setupBadCode(dashboardUrl));

  const lang: Lang = SUPPORTED_LANGS.includes(langArg as Lang)
    ? (langArg as Lang)
    : 'id';

  await supabase
    .from('accounts')
    .update({ wa_chat_id: msg.chatId, language: lang })
    .eq('id', linkCode.account_id);

  await supabase
    .from('link_codes')
    .update({ used: true })
    .eq('id', linkCode.id);

  await sendWA(msg.chatId, t[lang].setupOk((linkCode.accounts as any).name));
}
