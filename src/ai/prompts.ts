// IMPORTANT: This is the same buildPrompt function from test-gemini.ts.
// Only difference: categories is a parameter (comes from Supabase),
// not hardcoded. The replyContext parameter replaces replyTxn object
// so this file has zero dependencies — no circular imports.
import { Lang } from '../utils/lang';

export function buildPrompt(
  message: string,
  lang: Lang,
  categories: { income: string[]; expense: string[] },
  replyContext?: string, // context for single-txn reply
  multiContext?: string, // numbered list for EDIT_FROM_MULTIPLE
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
    replyContext ?? '',
    multiContext
      ? 'These transactions were recorded together:\n' +
        multiContext +
        '\nUser wants to edit one of them.'
      : '',
    'Message: ' + message,
    'Today: ' + today,
    '',
    'Available income categories: ' + categories.income.join(', '),
    'Available expense categories: ' + categories.expense.join(', '),
    '',
    'Examples (Indonesian → correct JSON):',
    '- "makan siang 25k" → {"action":"CREATE_TRANSACTION","payload":{"amount":25000,"type":"expense","category":"Kebutuhan Pokok","description":"makan siang","date":"' +
      today +
      '"}}',
    '- "gojek 15rb" → {"action":"CREATE_TRANSACTION","payload":{"amount":15000,"type":"expense","category":"Transportasi","description":"gojek","date":"' +
      today +
      '"}}',
    '- "gaji bulan ini 5jt" → {"action":"CREATE_TRANSACTION","payload":{"amount":5000000,"type":"income","category":"Gaji","description":"gaji bulan ini","date":"' +
      today +
      '"}}',
    '- "beli obat 30k" → {"action":"CREATE_TRANSACTION","payload":{"amount":30000,"type":"expense","category":"Kesehatan","description":"beli obat","date":"' +
      today +
      '"}}',
    '- "bayar listrik 200k" → {"action":"CREATE_TRANSACTION","payload":{"amount":200000,"type":"expense","category":"Tagihan","description":"bayar listrik","date":"' +
      today +
      '"}}',
    '',
    'Return ONLY valid JSON. No markdown, no extra text.',
    '{',
    '  action: CREATE_TRANSACTION | CREATE_MULTIPLE | EDIT_FROM_MULTIPLE',
    '        | EDIT_TRANSACTION | DELETE_TRANSACTION',
    '        | GET_SUMMARY | GET_CATEGORIES | ADD_CATEGORY | CHITCHAT | UNKNOWN,',
    '  payload: { amount, type, category, description, date, selection_index },',
    '  transactions: [ ...payloads ],  // CREATE_MULTIPLE only',
    '}',
    '',
    'Rules:',
    ...rules.map((r: string) => '- ' + r),
    '- type field MUST be "income" or "expense" (English only, never Indonesian)',
    '- Single transaction → CREATE_TRANSACTION with payload',
    '- Multiple transactions in one message → CREATE_MULTIPLE with transactions array',
    '- If multiContext present → user editing one transaction → EDIT_FROM_MULTIPLE',
    '  set selection_index (1-based) and include only changed fields in payload',
    '- If multiContext present and user wants to DELETE: DELETE_FROM_MULTIPLE with selection_index only',
    '- Pick closest matching category from list; do not invent new ones',
    '- For CHITCHAT/UNKNOWN: empty payload, write friendly reply field',
  ]
    .filter(Boolean)
    .join('\n');
}
