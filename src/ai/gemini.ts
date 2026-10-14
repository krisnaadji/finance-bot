import { supabase } from '../services/supabase';
import { buildPrompt } from './prompts';
import type { Lang } from '../utils/lang';
import type { Account, TxnForBot } from './types';
import { parseFinancialJson } from '../utils/financialValidation';

export async function callGemini(
  message: string,
  account: Account,
  lang: Lang,
  replyTxn?: TxnForBot,
  multiContext?: string,
  referenceInstant = new Date(),
): Promise<unknown> {
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL || 'gemini-2.5-flash-lite';
  if (!apiKey) throw new Error('AI_API_KEY not set');

  const { data: cats, error: categoryError } = await supabase
    .from('categories')
    .select('name, type')
    .eq('account_id', account.id)
    .eq('is_active', true)
    .order('sort_order');
  if (categoryError || !Array.isArray(cats)) throw new Error('AI category lookup unavailable');

  const categories = {
    income: (cats ?? []).filter((c) => c.type === 'income').map((c) => c.name),
    expense: (cats ?? []).filter((c) => c.type === 'expense').map((c) => c.name),
  };

  const replyContext = replyTxn
    ? [
        'User is replying to this existing transaction:',
        '- Description: ' + replyTxn.description,
        '- Amount: Rp' + replyTxn.amount,
        '- Category: ' + replyTxn.category_name,
        '- Date: ' + replyTxn.date,
        'Focus ONLY on EDIT_TRANSACTION or DELETE_TRANSACTION.',
        '',
      ].join('\n')
    : undefined;

  const prompt = buildPrompt(message, lang, categories, replyContext, multiContext, referenceInstant);

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    model +
    ':generateContent?key=' +
    apiKey;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
    }),
  });

  if (!res.ok) throw new Error('Gemini API error: ' + (await res.text()));

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const clean = text.replace(/```json|```/g, '').trim();
  return parseFinancialJson(clean);
}
