import { supabase } from '../services/supabase';
import { buildPrompt } from './prompts';
import { Lang } from '../utils/lang';
import { AIResponse, Account, TxnForBot } from './types';

export async function callGroq(
  message: string,
  account: Account,
  lang: Lang,
  replyTxn?: TxnForBot,
  multiContext?: string,
): Promise<AIResponse> {
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL || 'llama-3.1-8b-instant';
  if (!apiKey) throw new Error('AI_API_KEY not set');

  const { data: cats } = await supabase
    .from('categories')
    .select('name, type')
    .eq('account_id', account.id)
    .eq('is_active', true)
    .order('sort_order');

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

  const prompt = buildPrompt(message, lang, categories, replyContext, multiContext);

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 512,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) throw new Error('Groq API error: ' + (await res.text()));

  const json = await res.json();
  const text = json.choices?.[0]?.message?.content ?? '';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean) as AIResponse;
}
