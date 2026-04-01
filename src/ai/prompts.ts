// IMPORTANT: This is the same buildPrompt function from test-gemini.ts.
// Only difference: categories is a parameter (comes from Supabase),
// not hardcoded. The replyContext parameter replaces replyTxn object
// so this file has zero dependencies — no circular imports.
import { Lang } from '../utils/lang';

export function buildPrompt(
  message: string,
  lang: Lang,
  categories: { income: string[]; expense: string[] },
  replyContext?: string, // pre-formatted string describing the transaction being replied to
): string {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  const intro =
    lang === 'id'
      ? 'Kamu adalah asisten keuangan pribadi. Tulis field reply dalam bahasa Indonesia.'
      : 'You are a personal finance assistant. Write the reply field in English.';

  const rules =
    lang === 'id'
      ? [
          'Pahami bahasa Indonesia tidak baku dan slang',
          'k/rb = ribu, jt = juta. Contoh: 35k=35000, 5jt=5000000, 150rb=150000',
          'kemarin = ' +
            yesterday +
            ', tadi = earlier today, minggu lalu = last week',
          'Jika tidak ada tanggal eksplisit gunakan hari ini: ' + today,
        ]
      : [
          'Understand both English and informal Indonesian input',
          'k/rb = thousand, jt = million. Example: 35k=35000, 5jt=5000000',
          'kemarin = ' + yesterday + ', tadi = earlier today',
          'If no date mentioned use today: ' + today,
        ];

  return [
    intro,
    '',
    replyContext ? replyContext + '' : '',
    'Message: ' + message,
    'Today: ' + today,
    '',
    'Available income categories: ' + categories.income.join(', '),
    'Available expense categories: ' + categories.expense.join(', '),
    '',
    'Return ONLY a valid JSON object. No markdown, no extra text.',
    'Structure:',
    '{',
    '  action: CREATE_TRANSACTION | EDIT_TRANSACTION | DELETE_TRANSACTION |',
    '          GET_SUMMARY | GET_CATEGORIES | ADD_CATEGORY | CHITCHAT | UNKNOWN,',
    '  payload: {',
    '    amount: number (no symbols),',
    '    type: income or expense,',
    '    category: exact name from the list above,',
    '    description: short natural description,',
    '    date: YYYY-MM-DD,',
    '    period: this_month|last_month|this_week|custom (GET_SUMMARY only),',
    '    category_name: string (ADD_CATEGORY only),',
    '    category_type: income or expense (ADD_CATEGORY only)',
    '  },',
    '  reply: string (ONLY for CHITCHAT or UNKNOWN)',
    '}',
    '',
    'Rules:',
    ...rules.map((r: string) => '- ' + r),
    '- Pick closest matching category; do not invent new ones',
    '- Only include relevant payload fields',
    '- For CHITCHAT/UNKNOWN: empty payload, write friendly reply field',
  ]
    .filter(Boolean)
    .join('\n');
}
