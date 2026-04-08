import { supabase } from '../services/supabase';
import { buildPrompt } from './prompts';
import { Lang } from '../utils/lang';
import { AIResponse, Account, TxnForBot } from './types';

export async function callGemini(
  message: string,
  account: Account,
  lang: Lang,
  replyTxn?: TxnForBot, // single-txn reply context
  multiContext?: string, // multi-txn reply context
): Promise<AIResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const { data: cats } = await supabase
    .from('categories')
    .select('name, type')
    .eq('account_id', account.id)
    .eq('is_active', true)
    .order('sort_order');

  const categories = {
    income: (cats ?? []).filter((c) => c.type === 'income').map((c) => c.name),
    expense: (cats ?? [])
      .filter((c) => c.type === 'expense')
      .map((c) => c.name),
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

  const prompt = buildPrompt(
    message,
    lang,
    categories,
    replyContext,
    multiContext,
  );

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

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean) as AIResponse;
}
