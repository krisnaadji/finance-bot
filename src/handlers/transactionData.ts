import { supabase } from '../services/supabase';
import { getFinanceBudgetSpending, cents, formatCents } from '../services/reporting';
import { currentMonthRange } from '../utils/businessDate';
import { sendWA } from '../services/whatsapp';
import type { Account, IncomingMessage } from '../ai/types';
import type { Lang } from '../utils/lang';
import { isBusinessDate, isRecord, isUuid, parseAmount } from '../utils/financialValidation';
import { formatDate, formatIDR } from '../utils/format';
import { logger } from '../utils/logger';
import { t } from '../i18n/bot';
import { categoryColumns, categoryLabel, categoryPath, categoryRoot, decodeCategory, resolveCategoryId, type Category } from '../categories';
export class BotWriteError extends Error {
  constructor(public readonly kind: 'invalid' | 'dependency' | 'missing' | 'conflict' | 'inactive') {
    super(kind); this.name = 'BotWriteError';
  }
}
export class BotDeliveryError extends Error {
  constructor() { super('Post-commit delivery failed'); this.name = 'BotDeliveryError'; }
}
export type CategoryRow = Category;
export type CanonicalTxn = { id: string; account_id: string; amount: string; type: 'income' | 'expense'; description: string; date: string; category_id: string | null };
export const transactionColumns = 'id,account_id,amount,type,description,date,category_id';
export async function assertActiveLinkedAccount(account: Account, msg: IncomingMessage): Promise<void> {
  const result = await supabase.from('accounts').select('id,is_active,wa_chat_id')
    .eq('id', account.id).eq('wa_chat_id', msg.chatId).eq('is_active', true).maybeSingle();
  if (result.error) throw new BotWriteError('dependency');
  if (!result.data) throw new BotWriteError('inactive');
}
export async function loadWriteContext(account: Account, msg: IncomingMessage): Promise<{ categories: CategoryRow[]; displayName: string }> {
  await assertActiveLinkedAccount(account, msg);
  const cats = await supabase.from('categories').select(categoryColumns).eq('account_id', account.id);
  if (cats.error || !Array.isArray(cats.data)) throw new BotWriteError('dependency');
  let categories: CategoryRow[];
  try { categories = cats.data.map((row: unknown) => decodeCategory(row,account.id)); }
  catch { throw new BotWriteError('dependency'); }
  const member = await supabase.from('members').select('display_name').eq('account_id', account.id).eq('wa_phone', msg.rawFrom).maybeSingle();
  if (member.error) throw new BotWriteError('dependency');
  return { categories, displayName: typeof member.data?.display_name === 'string' ? member.data.display_name : msg.rawFrom };
}
export function classificationCategory(id: string | null | undefined, type: 'income' | 'expense', categories: CategoryRow[]): CategoryRow {
  try {
    const selected = resolveCategoryId(id,type,categories);
    if (selected) return selected;
    const fallback = categories.find(c => c.code === `${type}.other` && c.type === type && c.parent_id === null);
    if (!fallback || !resolveCategoryId(fallback.id,type,categories)) throw new Error('Missing Other category');
    return fallback;
  } catch { throw new BotWriteError('invalid'); }
}
export function canonicalTxn(value: unknown, accountId: string): CanonicalTxn {
  if (!isRecord(value) || !isUuid(value.id) || value.account_id !== accountId ||
      (value.type !== 'income' && value.type !== 'expense') || typeof value.description !== 'string' ||
      !isBusinessDate(value.date) || (value.category_id !== null && !isUuid(value.category_id))) throw new BotWriteError('dependency');
  const amount = parseAmount(value.amount);
  if (amount === null) throw new BotWriteError('dependency');
  return { id: value.id, account_id: accountId, amount, type: value.type,
    description: value.description, date: value.date, category_id: value.category_id };
}
export function categoryName(txn: CanonicalTxn, categories: CategoryRow[], lang: Lang): string {
  if (txn.category_id === null) return t[lang].uncategorized;
  const cat = categories.find((row) => row.id === txn.category_id && row.account_id === txn.account_id);
  if (!cat) throw new BotWriteError('dependency');
  return categoryPath(cat,categories,lang);
}
export function transactionReceipt(txn: CanonicalTxn, categories: CategoryRow[], lang: Lang, edited = false): string {
  const receipt = t[lang].txnCreated(txn.description, formatIDR(txn.amount), categoryName(txn, categories, lang), formatDate(txn.date, lang), txn.type);
  return edited ? t[lang].txnEdited + '\n' + receipt : receipt;
}
export async function deliverTransactionReceipt(rows: CanonicalTxn[], account: Account, msg: IncomingMessage, text: string): Promise<void> {
  try {
    const outcome=await sendWA(msg.chatId,text);
    if(outcome.kind!=='accepted')throw new BotDeliveryError();
    const id=outcome.providerMessageId;
    const result = await supabase.from('transactions').update({ wa_bot_message_id: id })
      .eq('account_id', account.id).in('id', rows.map((row) => row.id)).select('id');
    if (result.error || !Array.isArray(result.data) || result.data.length !== rows.length ||
        !rows.every((row) => result.data.some((saved) => saved.id === row.id))) throw new BotDeliveryError();
  } catch {
    logger.error('transactions', 'receipt_delivery_failed', undefined, { accountId: account.id, transactionIds: rows.map((row) => row.id) });
    throw new BotDeliveryError();
  }
}
export async function budgetWarnings(rows: CanonicalTxn[], categories: CategoryRow[], accountId: string, lang: Lang): Promise<string> {
  // A warning-query failure does not undo or repeat a committed transaction.
  try {
    const { from, to } = currentMonthRange();
    const expenseIds = [...new Set(rows.filter(row => row.type === 'expense' && row.category_id && row.date >= from && row.date <= to).map(row => {
      const cat=categories.find(c=>c.id===row.category_id && c.account_id===accountId);
      if (!cat) throw new BotWriteError('dependency');
      return categoryRoot(cat,categories).id;
    }))];
    if (!expenseIds.length) return '';
    const budgets = await supabase.from('budgets').select('category_id,amount::text').eq('account_id', accountId);
    if (budgets.error || !Array.isArray(budgets.data)) throw new BotWriteError('dependency');
    const ids = expenseIds.filter(id => budgets.data.some(budget => budget.category_id === id));
    if (!ids.length) return '';
    const spending = await getFinanceBudgetSpending(accountId, from, to);
    const warnings: string[] = [];
    for (const id of ids) {
      const budget = budgets.data.find((row) => row.category_id === id);
      if (!budget) continue;
      if (typeof budget.amount !== 'string') throw new BotWriteError('dependency');
      const budgetCents = cents(budget.amount);
      if (budgetCents <= 0n) throw new BotWriteError('dependency');
      const totalCents = cents(spending.spendingByCategoryId[id] ?? '0.00');
      const pct = ((totalCents * 100n + budgetCents / 2n) / budgetCents).toString();
      const category=categories.find(row=>row.id===id);
      if (!category) throw new BotWriteError('dependency');
      const name = categoryLabel(category,lang);
      if (totalCents > budgetCents) warnings.push(lang === 'id'
        ? `⚠️ *Budget ${name} terlampaui!* Rp${formatIDR(formatCents(totalCents))} / Rp${formatIDR(budget.amount)} (${pct}%)`
        : `⚠️ *${name} budget exceeded!* Rp${formatIDR(formatCents(totalCents))} / Rp${formatIDR(budget.amount)} (${pct}%)`);
      else if (BigInt(pct) >= 80n) warnings.push(`⚠️ Budget ${name}: Rp${formatIDR(formatCents(totalCents))} / Rp${formatIDR(budget.amount)} (${pct}%)`);
    }
    return warnings.length ? '\n\n' + warnings.join('\n') : '';
  } catch {
    logger.warn('transactions', 'budget_warning_unavailable', { accountId });
    return '\n\n' + t[lang].budgetWarningUnavailable;
  }
}
