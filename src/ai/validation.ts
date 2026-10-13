import type { AIPayload, AIResponse } from './types';
import { isBusinessDate, isRecord, parseAmount } from '../utils/financialValidation';
export class InvalidAICommand extends Error {
  constructor() { super('Invalid AI command'); this.name = 'InvalidAICommand'; }
}
function reject(): never { throw new InvalidAICommand(); }
function txnType(value: unknown): 'income' | 'expense' {
  if (typeof value !== 'string') return reject();
  switch (value.trim().toLowerCase()) {
    case 'income': case 'pemasukan': return 'income';
    case 'expense': case 'pengeluaran': return 'expense';
    default: return reject();
  }
}
function selection(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return reject();
  return value;
}
const transactionKeys: Record<string, true> = {
  amount: true, type: true, category: true, description: true, date: true, selection_index: true,
};
function transaction(value: unknown, create: boolean): AIPayload {
  if (!isRecord(value)) return reject();
  if (Object.keys(value).some((key) => !Object.hasOwn(transactionKeys, key))) return reject();
  const p: AIPayload = {};
  if (Object.hasOwn(value, 'amount')) { const amount = parseAmount(value.amount); if (amount === null) return reject(); p.amount = amount; }
  if (Object.hasOwn(value, 'type')) p.type = txnType(value.type);
  if (Object.hasOwn(value, 'date')) { if (!isBusinessDate(value.date)) return reject(); p.date = value.date; }
  if (Object.hasOwn(value, 'description')) { if (typeof value.description !== 'string') return reject(); p.description = value.description; }
  if (Object.hasOwn(value, 'category')) {
    if (value.category !== null && typeof value.category !== 'string') return reject();
    p.category = value.category === null ? null : value.category.trim() || null;
  }
  if (Object.hasOwn(value, 'selection_index')) p.selection_index = selection(value.selection_index);
  if (create && (!p.amount || !p.type || !p.date)) return reject();
  if (!create && !Object.keys(p).some((key) => key !== 'selection_index')) return reject();
  return p;
}
export function validateAIResponse(value: unknown): AIResponse {
  if (!isRecord(value)) return reject();
  const reply = typeof value.reply === 'string' ? value.reply : undefined;
  const action = value.action;
  const raw = value.payload;
  let payload: AIPayload = {};
  let transactions: AIPayload[] | undefined;
  let selectionIndex: number | undefined;
  switch (action) {
    case 'CREATE_TRANSACTION': payload = transaction(raw, true); break;
    case 'CREATE_MULTIPLE':
      if (!Array.isArray(value.transactions) || !value.transactions.length) return reject();
      transactions = value.transactions.map((item) => transaction(item, true)); break;
    case 'EDIT_TRANSACTION': case 'EDIT_FROM_MULTIPLE': payload = transaction(raw, false); break;
    case 'DELETE_TRANSACTION': case 'DELETE_FROM_MULTIPLE':
      if (raw != null && !isRecord(raw)) return reject();
      if (isRecord(raw) && Object.hasOwn(raw, 'selection_index')) payload.selection_index = selection(raw.selection_index);
      break;
    case 'ADD_CATEGORY':
      if (!isRecord(raw) || Object.keys(raw).some((key) => !['category_name', 'category_type'].includes(key)) ||
          typeof raw.category_name !== 'string' || !raw.category_name.trim()) return reject();
      payload = { category_name: raw.category_name.trim(), category_type: txnType(raw.category_type) }; break;
    case 'GET_SUMMARY':
      if (raw != null && !isRecord(raw)) return reject();
      if (isRecord(raw)) {
        if (raw.period !== undefined) { if (typeof raw.period !== 'string') return reject(); payload.period = raw.period; }
        for (const key of ['salary_month', 'salary_year'] as const) {
          const n = raw[key];
          if (n !== undefined) {
            if (typeof n !== 'number' || !Number.isInteger(n) || n < (key === 'salary_month' ? 1 : 2000) || n > (key === 'salary_month' ? 12 : 2100)) return reject();
            payload[key] = n;
          }
        }
      }
      break;
    case 'GET_CATEGORIES': case 'CHITCHAT': case 'UNKNOWN': break;
    default: return { action: 'UNKNOWN', payload: {}, ...(reply === undefined ? {} : { reply }) };
  }
  if (value.selection_index !== undefined) selectionIndex = selection(value.selection_index);
  if (selectionIndex !== undefined && payload.selection_index !== undefined && selectionIndex !== payload.selection_index) return reject();
  if ((action === 'EDIT_FROM_MULTIPLE' || action === 'DELETE_FROM_MULTIPLE') && selectionIndex === undefined && payload.selection_index === undefined) return reject();
  return { action, payload, ...(transactions ? { transactions } : {}),
    ...(selectionIndex !== undefined ? { selection_index: selectionIndex } : {}), ...(reply !== undefined ? { reply } : {}) };
}
