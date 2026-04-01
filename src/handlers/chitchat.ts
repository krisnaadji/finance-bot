import { sendWA } from '../services/whatsapp';
import { Lang } from '../utils/lang';
import { t } from '../i18n/bot';
import { AIResponse, Account, IncomingMessage } from '../ai/types';

export async function chitchat(
  ai: AIResponse,
  account: Account,
  msg: IncomingMessage,
  lang: Lang,
) {
  await sendWA(msg.chatId, ai.reply || t[lang].helpText);
}
