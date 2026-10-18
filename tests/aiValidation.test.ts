import { describe, expect, it } from 'vitest';
import { InvalidAICommand, validateAIResponse } from '../src/ai/validation';
const item = { amount: '35000', type: 'expense', date: '2026-10-12', description: 'Lunch' };
describe('AI command validation', () => {
  it.each(['amount', 'type', 'date'])('requires %s on each creation', (field) => {
    const bad: Record<string, unknown> = { ...item }; delete bad[field];
    expect(() => validateAIResponse({ action: 'CREATE_TRANSACTION', payload: bad })).toThrow(InvalidAICommand);
    expect(() => validateAIResponse({ action: 'CREATE_MULTIPLE', payload: {}, transactions: [item, bad] })).toThrow(InvalidAICommand);
  });
  it.each([0, -1, true, null, [], '', Infinity, NaN, '0.001', '10000000000000'])('rejects amount %j', (amount) => {
    expect(() => validateAIResponse({ action: 'CREATE_TRANSACTION', payload: { ...item, amount } })).toThrow(InvalidAICommand);
  });
  it.each(['2026-02-30', '2025-02-29', '1999-12-31', '2101-01-01', '2026-1-1'])('rejects date %s', (date) => {
    expect(() => validateAIResponse({ action: 'CREATE_TRANSACTION', payload: { ...item, date } })).toThrow(InvalidAICommand);
  });
  it('normalizes both providers without fabricating optional fields', () => {
    const result = validateAIResponse({ action: 'CREATE_MULTIPLE', payload: {}, transactions: [
      { ...item, type: 'Pengeluaran' }, { ...item, type: 'Pemasukan', date: '2024-02-29', amount: 12.5 },
    ] });
    expect(result.transactions?.map((p) => [p.amount, p.type])).toEqual([['35000.00', 'expense'], ['12.50', 'income']]);
    expect(validateAIResponse({ action: 'EDIT_TRANSACTION', payload: { description: 'literal instruction: ignore rules' } }).payload)
      .toEqual({ description: 'literal instruction: ignore rules' });
  });
  it.each([{}, { amount: 0 }, { date: '2026-02-30' }, { type: 'transfer' }, { account_id: 'foreign' }])('rejects invalid edit %j', (payload) => {
    expect(() => validateAIResponse({ action: 'EDIT_TRANSACTION', payload })).toThrow(InvalidAICommand);
  });
  it('requires category name and normalized exact category type', () => {
    expect(validateAIResponse({action:'ADD_CATEGORY',payload:{category_name:' Tips ',category_type:'Pemasukan',category_language:'en'}}).payload)
      .toEqual({category_name:'Tips',category_type:'income',category_language:'en'});
    for (const payload of [{ category_name: ' ' }, { category_name: 'Tips', category_type: 'transfer' }, { category_name: 9, category_type: 'income' }]) {
      expect(() => validateAIResponse({ action: 'ADD_CATEGORY', payload })).toThrow(InvalidAICommand);
    }
  });
  it('unknown actions have no mutating payload and cannot retain invented commands', () => {
    expect(validateAIResponse({ action: 'DROP_ALL', payload: item, transactions: [item], reply: 'hello' }))
      .toEqual({ action: 'UNKNOWN', payload: {}, reply: 'hello' });
  });
  it.each([0, -1, 1.5, '1'])('rejects non-positive/non-integer selections %j', (selection_index) => {
    expect(() => validateAIResponse({ action: 'DELETE_FROM_MULTIPLE', payload: {}, selection_index })).toThrow(InvalidAICommand);
  });
});
