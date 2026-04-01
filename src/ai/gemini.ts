import { supabase } from '../services/supabase';
import { buildPrompt } from './prompts';
import { Lang } from '../utils/lang';
import { AIResponse, Account, TxnForBot } from './types';

export async function callGemini(
  message: string,
  account: Account,
  lang: Lang, // resolved by router before calling
  replyTxn?: TxnForBot, // pass when user replied to a transaction
): Promise<AIResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  // Fetch account's active categories from Supabase
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

  // If replying to a transaction, format context as a string
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

  const prompt = buildPrompt(message, lang, categories, replyContext);

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
      generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
    }),
  });

  if (!res.ok) throw new Error('Gemini API error: ' + (await res.text()));

  const data = await res.json();
  const raw: string = data.candidates[0].content.parts[0].text;
  const cleaned = raw.replace(/^[^{]*/, '').replace(/[^}]*$/, '');
  return JSON.parse(cleaned) as AIResponse;
}
