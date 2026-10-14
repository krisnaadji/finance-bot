import { Lang } from '../utils/lang';
import { AIResponse, Account, TxnForBot } from './types';
import { callGemini } from './gemini';
import { callGroq } from './groq';
import { InvalidAICommand, validateAIResponse } from './validation';

export async function callAI(
  message: string,
  account: Account,
  lang: Lang,
  replyTxn?: TxnForBot,
  multiContext?: string,
  referenceInstant = new Date(),
): Promise<AIResponse> {
  const provider = process.env.AI_PROVIDER ?? 'groq';
  try {
    const raw: unknown = provider === 'gemini'
      ? await callGemini(message, account, lang, replyTxn, multiContext, referenceInstant)
      : await callGroq(message, account, lang, replyTxn, multiContext, referenceInstant);
    return validateAIResponse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw new InvalidAICommand();
    throw error;
  }
}
