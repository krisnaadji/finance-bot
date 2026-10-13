import { supabase } from '../services/supabase';
import { sendWA } from '../services/whatsapp';
import type { Account, IncomingMessage } from '../ai/types';
import type { Lang } from '../utils/lang';
import { isBusinessDate, isRecord, isUuid, parseAmount } from '../utils/financialValidation';
import { formatDate, formatIDR } from '../utils/format';
import { logger } from '../utils/logger';
import { t } from '../i18n/bot';
export class BotWriteError extends Error {
  constructor(public readonly kind: 'invalid' | 'dependency' | 'missing' | 'conflict' | 'inactive') {
    super(kind); this.name = 'BotWriteError';
  }
}
export class BotDeliveryError extends Error {
  constructor() { super('Post-commit delivery failed'); this.name = 'BotDeliveryError'; }
}
export type CategoryRow = { id: string; account_id: string; name: string; type: 'income' | 'expense'; is_active: boolean };
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
  const cats = await supabase.from('categories').select('id,account_id,name,type,is_active').eq('account_id', account.id);
  if (cats.error || !Array.isArray(cats.data)) throw new BotWriteError('dependency');
  const categories: CategoryRow[] = cats.data.map((row: unknown) => {
    if (!isRecord(row) || !isUuid(row.id) || row.account_id !== account.id || typeof row.name !== 'string' ||
        (row.type !== 'income' && row.type !== 'expense') || typeof row.is_active !== 'boolean') throw new BotWriteError('dependency');
    return { id: row.id, account_id: account.id, name: row.name, type: row.type, is_active: row.is_active };
  });
  const member = await supabase.from('members').select('display_name').eq('account_id', account.id).eq('wa_phone', msg.rawFrom).maybeSingle();
  if (member.error) throw new BotWriteError('dependency');
  return { categories, displayName: typeof member.data?.display_name === 'string' ? member.data.display_name : msg.rawFrom };
}
export function resolveCategory(name: string | null | undefined, type: 'income' | 'expense', categories: CategoryRow[]): CategoryRow | null {
  if (!name) return null;
  const matches = categories.filter((cat) => cat.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!matches.length) return null;
  if (matches.length !== 1 || !matches[0].is_active || matches[0].type !== type) throw new BotWriteError('invalid');
  return matches[0];
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
  return cat.name;
}
export function transactionReceipt(txn: CanonicalTxn, categories: CategoryRow[], lang: Lang, edited = false): string {
  const receipt = t[lang].txnCreated(txn.description, formatIDR(txn.amount), categoryName(txn, categories, lang), formatDate(txn.date, lang), txn.type);
  return edited ? t[lang].txnEdited + '\n' + receipt : receipt;
}
export async function deliverTransactionReceipt(rows: CanonicalTxn[], account: Account, msg: IncomingMessage, text: string): Promise<void> {
  try {
    const id = await sendWA(msg.chatId, text);
    if (typeof id !== 'string' || !id.trim()) throw new BotDeliveryError();
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
  // Preserve current monthly warning behavior. A warning-query failure does not undo or repeat a committed transaction.
  try {
    const budgets = await supabase.from('budgets').select('category_id,amount').eq('account_id', accountId);
    if (budgets.error || !Array.isArray(budgets.data)) throw new BotWriteError('dependency');
    const ids = [...new Set(rows.filter((row) => row.type === 'expense' && row.category_id).map((row) => row.category_id!))];
    const warnings: string[] = [];
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const to = now.toISOString().split('T')[0];
    for (const id of ids) {
      const budget = budgets.data.find((row) => row.category_id === id);
      if (!budget) continue;
      const amount = Number(budget.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new BotWriteError('dependency');
      const spend = await supabase.from('transactions').select('amount').eq('account_id', accountId)
        .eq('category_id', id).eq('type', 'expense').gte('date', from).lte('date', to);
      if (spend.error || !Array.isArray(spend.data)) throw new BotWriteError('dependency');
      const total = spend.data.reduce((sum, row) => sum + Number(row.amount), 0);
      if (!Number.isFinite(total)) throw new BotWriteError('dependency');
      const pct = Math.round(total / amount * 100);
      const name = categories.find((row) => row.id === id)?.name ?? t[lang].uncategorized;
      if (total > amount) warnings.push(lang === 'id'
        ? `⚠️ *Budget ${name} terlampaui!* Rp${formatIDR(total)} / Rp${formatIDR(amount)} (${pct}%)`
        : `⚠️ *${name} budget exceeded!* Rp${formatIDR(total)} / Rp${formatIDR(amount)} (${pct}%)`);
      else if (pct >= 80) warnings.push(`⚠️ Budget ${name}: Rp${formatIDR(total)} / Rp${formatIDR(amount)} (${pct}%)`);
    }
    return warnings.length ? '\n\n' + warnings.join('\n') : '';
  } catch {
    logger.warn('transactions', 'budget_warning_unavailable', { accountId });
    return '\n\n' + t[lang].budgetWarningUnavailable;
  }
}
