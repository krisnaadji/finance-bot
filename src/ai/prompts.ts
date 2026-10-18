import type { Lang } from '../utils/lang';
import { businessDate, shiftCivilDay } from '../utils/businessDate';
import { categoryPath, type Category } from '../categories';

export function buildPrompt(message: string, lang: Lang, categories: readonly Category[], replyContext?: string, multiContext?: string, referenceInstant = new Date()): string {
  const today = businessDate(referenceInstant);
  const examples: [string,string][] = [
    ['beli makanan 30rb','expense.food'],['makan di warteg 30rb','expense.food.dining_out'],
    ['belanja sayur telur 75k','expense.food.groceries'],['pesen makan gofood 45rb','expense.food.delivery'],
    ['ngopi 22k','expense.food.snacks_coffee'],['bayar parkir 5rb','expense.transport.parking_tolls'],
    ['bensin 100rb','expense.transport.fuel'],['bayar kos 1.5jt','expense.housing.rent'],
    ['beli obat 30k','expense.health.medicine'],['gajian masuk 8jt','salary'],['bonus kantor masuk 2jt','income.bonus'],
  ];
  return [
    `You are a finance assistant. Write reply in ${lang === 'id' ? 'Indonesian' : 'English'}.`,
    replyContext ?? '', multiContext ? `Recorded batch:\n${multiContext}\nSelect the original 1-based ordinal for edits/deletes.` : '',
    `Message: ${message}`, `Today (Asia/Jakarta): ${today}; kemarin/yesterday: ${shiftCivilDay(today,-1)}`,
    'Eligible account categories (IDs are identities; labels and paths are presentation only):',
    ...categories.map(c => JSON.stringify({id:c.id,type:c.type,code:c.code,parent_id:c.parent_id,path_id:categoryPath(c,categories,'id'),path_en:categoryPath(c,categories,'en')})),
    'Examples (use only the actual ID shown):',
    ...examples.flatMap(([input,code]) => { const c=categories.find(row=>row.code===code); return c ? [`${JSON.stringify(input)} => category_id=${JSON.stringify(c.id)}`] : []; }),
    'Return ONLY JSON: {action,payload,transactions?,selection_index?,reply?}.',
    'Actions: CREATE_TRANSACTION, CREATE_MULTIPLE, EDIT_TRANSACTION, EDIT_FROM_MULTIPLE, DELETE_TRANSACTION, DELETE_FROM_MULTIPLE, GET_SUMMARY, GET_CATEGORIES, ADD_CATEGORY, CHITCHAT, UNKNOWN.',
    'Transaction payload keys: amount,type,category_id,description,date,selection_index. amount must be an exact decimal string, type income|expense, date YYYY-MM-DD.',
    'Understand Indonesian slang and mixed English: k/rb=ribu/thousand, jt=juta/million; 35k=35000, 1.5jt=1500000. warteg/makan di luar=dining out; sayur/telur/bahan masak=groceries; gofood/grabfood/shopeefood=food delivery; ngopi/jajan=snacks & coffee; bensin/BBM=fuel; kos/kontrakan=rent; gajian=regular salary, bonus/THR=bonus, never regular salary.',
    'One classification request selects both parent and optional child. Use a child only when supported by the message. beli makanan selects Food & Drinks directly, not an invented detail. If no parent can be established use matching expense.other/income.other ID or omit category_id. Never invent an ID or classify by a label.',
    'Multiple attributed expenses (lunch 35k sama kopi 15k) => CREATE_MULTIPLE, separate rows with independent amounts/descriptions/category_id. Preserve existing income/expense treatment of top-ups; do not invent transfers.',
    'No explicit date => today. Edits include only changed fields; omitted category_id preserves the old reference. Do not ask for optional subcategory detail.',
    'Reply context => only EDIT_TRANSACTION or DELETE_TRANSACTION; batch => EDIT_FROM_MULTIPLE or DELETE_FROM_MULTIPLE with original selection_index.',
    'GET_SUMMARY payload: period (this_month|salary_cycle), optional salary_month 1-12 and salary_year. rekap gaji februari 2026 => salary_cycle,2,2026.',
    'ADD_CATEGORY payload: category_name (original label), category_type income|expense, category_language id|en, optional parent_category_id (eligible root ID), optional translated_name (explicit user translation takes precedence). Missing parent creates a root. Never guess an ambiguous parent. Preserve original language; translation is optional and cannot block saving.',
    'CHITCHAT/UNKNOWN => empty payload and friendly reply.',
  ].filter(Boolean).join('\n');
}
