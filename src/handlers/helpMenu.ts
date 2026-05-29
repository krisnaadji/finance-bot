import { AIResponse, IncomingMessage } from '../ai/types';
import { t } from '../i18n/bot';
import { sendWA } from '../services/whatsapp';
import { Lang } from '../utils/lang';

const HELP_CONTEXT_TTL_MS = 15 * 60 * 1000;
const helpMessageExpiresAt = new Map<string, number>();

export type HelpShortcut =
  | 'summary'
  | 'salary_summary'
  | 'categories'
  | 'search_hint'
  | 'dashboard'
  | 'language_hint'
  | 'setup_hint';

export async function sendHelp(msg: IncomingMessage, lang: Lang): Promise<void> {
  const botMessageId = await sendWA(msg.chatId, t[lang].helpText);
  if (botMessageId) {
    helpMessageExpiresAt.set(botMessageId, Date.now() + HELP_CONTEXT_TTL_MS);
  }
}

export function resolveHelpShortcut(msg: IncomingMessage): HelpShortcut | null {
  if (!msg.repliedToId) return null;

  const expiresAt = helpMessageExpiresAt.get(msg.repliedToId);
  if (!expiresAt) return null;

  if (expiresAt < Date.now()) {
    helpMessageExpiresAt.delete(msg.repliedToId);
    return null;
  }

  switch (msg.text.trim()) {
    case '1':
      return 'summary';
    case '2':
      return 'salary_summary';
    case '3':
      return 'categories';
    case '4':
      return 'search_hint';
    case '5':
      return 'dashboard';
    case '6':
      return 'language_hint';
    case '7':
      return 'setup_hint';
    default:
      return null;
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
