import { AIResponse, IncomingMessage } from '../ai/types';
import { t } from '../i18n/bot';
import { sendWA } from '../services/whatsapp';
import { Lang } from '../utils/lang';
import { supabase } from '../services/supabase';

export type HelpShortcut =
  | 'summary'
  | 'salary_summary'
  | 'categories'
  | 'search_hint'
  | 'dashboard'
  | 'language_hint'
  | 'setup_hint';

export async function sendHelp(msg: IncomingMessage, lang: Lang): Promise<void> {
  await sendWA(msg.chatId, t[lang].helpText);
}

export async function loadHelpContext(accountId: string, chatId: string, providerMessageId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('load_bot_help_context', {
    p_account_id: accountId,
    p_chat_id: chatId,
    p_gateway: process.env.GATEWAY ?? 'meta',
    p_message_id: providerMessageId,
  });
  if (error || typeof data !== 'boolean') throw new Error('help_context_unavailable');
  return data;
}

export function resolveHelpShortcut(msg: IncomingMessage, hasContext: boolean): HelpShortcut | null {
  if (!hasContext || !msg.repliedToId) return null;
  switch (msg.text.trim()) {
    case '1': return 'summary';
    case '2': return 'salary_summary';
    case '3': return 'categories';
    case '4': return 'search_hint';
    case '5': return 'dashboard';
    case '6': return 'language_hint';
    case '7': return 'setup_hint';
    default: return null;
  }
}

export function helpShortcutHint(shortcut: HelpShortcut, lang: Lang): string {
  if (shortcut === 'search_hint') {
    return lang === 'id'
      ? 'Contoh: */cari netflix*'
      : 'Example: */search netflix*';
  }
  if (shortcut === 'language_hint') {
    return lang === 'id'
      ? 'Pilih bahasa dengan */language id* atau */language en*.'
      : 'Choose a language with */language id* or */language en*.';
  }
  if (shortcut === 'setup_hint') {
    return lang === 'id'
      ? 'Masukkan kode dari dashboard dengan format */setup KODE*.'
      : 'Enter the code from the dashboard with */setup CODE*.';
  }
  return '';
}

export function summaryShortcutAi(period: 'this_month' | 'salary_cycle'): AIResponse {
  return {
    action: 'GET_SUMMARY',
    payload: { period },
  };
}
