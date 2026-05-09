import { Lang } from '../utils/lang';
import { AIResponse, Account, TxnForBot } from './types';
import { callGemini } from './gemini';
import { callGroq } from './groq';

export async function callAI(
  message: string,
  account: Account,
  lang: Lang,
  replyTxn?: TxnForBot,
  multiContext?: string,
): Promise<AIResponse> {
  const provider = process.env.AI_PROVIDER ?? 'groq';
  if (provider === 'gemini') return callGemini(message, account, lang, replyTxn, multiContext);
  return callGroq(message, account, lang, replyTxn, multiContext);
}
