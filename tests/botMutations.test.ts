import { beforeEach, expect, it, vi } from 'vitest';
import type { AIResponse, Account, IncomingMessage } from '../src/ai/types';
import { seedSecurityDb, accountId, foreignAccountId, expenseId, incomeId, inactiveId, txnId, type SecurityDb } from './helpers/securityDb';
import type { SendOutcome } from '../src/delivery/types';
import type { Row } from './helpers/securityDb';
const accepted = (providerMessageId: string): SendOutcome => ({ kind: 'accepted', providerMessageId });
const state = vi.hoisted(() => ({ db: null as unknown, sendWA: vi.fn<(to: string, text: string) => Promise<SendOutcome>>() }));
vi.mock('../src/services/supabase', () => ({ supabase: new Proxy({}, { get: (_target, key) => {
  const db = state.db as SecurityDb;
  const value = db[key as keyof typeof db]; return typeof value === 'function' ? value.bind(db) : value;
} }) }));
vi.mock('../src/services/whatsapp', () => ({ sendWA: state.sendWA }));
import { createTxn } from '../src/handlers/createTxn';
import { createMultiple } from '../src/handlers/createMultiple';
import { editTxn } from '../src/handlers/editTxn';
import { addCategory } from '../src/handlers/addCategory';
import { BotDeliveryError, BotWriteError } from '../src/handlers/transactionData';
import { InvalidAICommand } from '../src/ai/validation';
import { t } from '../src/i18n/bot';
let db: SecurityDb;
let account: Account;
const msg: IncomingMessage = { messageId: 'incoming-1', chatId: 'test-group', rawFrom: 'requester-A', text: 'test input', repliedToId: null };
const payload = { amount: '35.50', type: 'expense' as const, date: '2026-10-12', description: 'Lunch', category_id: expenseId };
beforeEach(() => { db = seedSecurityDb(); state.db = db; account = db.tables.accounts[0] as unknown as Account; state.sendWA.mockReset().mockResolvedValue(accepted('new-receipt')); });
it.each(['amount', 'type', 'date'])('single/batch invalid %s causes no financial write', async (key) => {
  const bad: Record<string, unknown> = { ...payload }; delete bad[key];
  await expect(createTxn({ action: 'CREATE_TRANSACTION', payload: bad } as AIResponse, account, msg, 'en')).rejects.toBeInstanceOf(InvalidAICommand);
  await expect(createMultiple({ action: 'CREATE_MULTIPLE', payload: {}, transactions: [payload, bad] } as AIResponse, account, msg, 'en')).rejects.toBeInstanceOf(InvalidAICommand);
  expect(db.tables.transactions).toHaveLength(1); expect(state.sendWA).not.toHaveBeenCalled(); expect(db.writes).toEqual([]);
});
it.each([inactiveId,incomeId])('rejects selecting inactive/incompatible ID %s', async (category_id) => {
  await expect(createTxn({action:'CREATE_TRANSACTION',payload:{...payload,category_id}},account,msg,'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.transactions).toHaveLength(1); expect(state.sendWA).not.toHaveBeenCalled();
});
it.each(['20000000-0000-4000-8000-000000000099','20000000-0000-4000-8000-000000000004'])('rejects unknown/foreign ID %s instead of Other', async (category_id) => {
  await expect(createTxn({action:'CREATE_TRANSACTION',payload:{...payload,category_id}},account,msg,'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.transactions).toHaveLength(1); expect(state.sendWA).not.toHaveBeenCalled();
});
it('success reflects persisted exact amount, category and attribution', async () => {
  await createTxn({ action: 'CREATE_TRANSACTION', payload }, account, msg, 'en');
  expect(db.tables.transactions[1]).toMatchObject({ amount: '35.50', category_id: expenseId, recorded_by_name: 'A', recorded_by_phone: 'requester-A', wa_bot_message_id: 'new-receipt' });
  expect(state.sendWA.mock.calls[0][1]).toContain('Rp35,50'); expect(state.sendWA.mock.calls[0][1]).toContain('Food');
});
it('a receipt send failure does not compensate or repeat a committed insert', async () => {
  state.sendWA.mockResolvedValueOnce({ kind: 'uncertain', code: 'transport_unknown' });
  await expect(createTxn({ action: 'CREATE_TRANSACTION', payload }, account, msg, 'en')).rejects.toBeInstanceOf(BotDeliveryError);
  expect(db.tables.transactions).toHaveLength(2); expect(db.writes.filter((write) => write.table === 'transactions' && write.mode === 'insert')).toHaveLength(1);
});
it('receipt-ID write failure keeps one financial write and exposes delivery error', async () => {
  db.failures.push({ table: 'transactions', mode: 'update' });
  await expect(createTxn({ action: 'CREATE_TRANSACTION', payload }, account, msg, 'en')).rejects.toBeInstanceOf(BotDeliveryError);
  expect(db.tables.transactions).toHaveLength(2);
});
it('type-only edit cannot retain expense category as income', async () => {
  await expect(editTxn({ action: 'EDIT_TRANSACTION', payload: { type: 'income' } }, txnId, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.transactions[0].type).toBe('expense'); expect(state.sendWA).not.toHaveBeenCalled();
});
it('description edit preserves historical inactive category; reselection does not', async () => {
  db.tables.transactions[0].category_id = inactiveId;
  await editTxn({ action: 'EDIT_TRANSACTION', payload: { description: 'History corrected' } }, txnId, account, msg, 'en');
  expect(db.tables.transactions[0]).toMatchObject({ description: 'History corrected', category_id: inactiveId, edited_by_name: 'A' });
  expect(state.sendWA.mock.calls[0][1]).toContain('Old food'); state.sendWA.mockClear();
  await expect(editTxn({ action: 'EDIT_TRANSACTION', payload: { category_id: inactiveId } }, txnId, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it.each([false, true])('failed/zero-row edit never sends success (zero=%s)', async (zero) => {
  db.failures.push({ table: 'transactions', mode: 'update', zero });
  await expect(editTxn({ action: 'EDIT_TRANSACTION', payload: { amount: '99.00' } }, txnId, account, msg, 'en'))
    .rejects.toMatchObject({ kind: zero ? 'conflict' : 'dependency' });
  expect(db.tables.transactions[0].amount).toBe('20.00'); expect(state.sendWA).not.toHaveBeenCalled();
});
it.each(['read', 'insert'] as const)('category %s failure never claims success', async (mode) => {
  db.failures.push({ table: 'categories', mode });
  await expect(addCategory({ action: 'ADD_CATEGORY', payload: { category_name: 'Travel', category_type: 'expense', category_language:'en' } }, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.categories).toHaveLength(4); expect(state.sendWA).not.toHaveBeenCalled();
});
it('category zero-row insert is not success', async () => {
  db.failures.push({ table: 'categories', mode: 'insert', zero: true });
  await expect(addCategory({ action: 'ADD_CATEGORY', payload: { category_name: 'Travel', category_type: 'expense', category_language:'en' } }, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('batch rollback is checked; a failed compensation reports persisted records', async () => {
  db.failures.push({ table: 'transactions', mode: 'insert', skip: 1 }, { table: 'transactions', mode: 'delete' });
  await createMultiple({ action: 'CREATE_MULTIPLE', payload: {}, transactions: [payload, { ...payload, description: 'Taxi' }] }, account, msg, 'en');
  expect(db.tables.transactions).toHaveLength(2); expect(state.sendWA.mock.calls[0][1]).toContain(t.en.batchPartial);
  expect(state.sendWA.mock.calls[0][1]).toContain('Lunch'); expect(state.sendWA.mock.calls[0][1]).not.toContain('Taxi');
});
it('category read outage and inactive account prevent writes', async () => {
  db.failures.push({ table: 'categories', mode: 'read' });
  await expect(createTxn({ action: 'CREATE_TRANSACTION', payload }, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  db.tables.accounts[0].is_active = false;
  await expect(createTxn({ action: 'CREATE_TRANSACTION', payload }, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.transactions).toHaveLength(1); expect(state.sendWA).not.toHaveBeenCalled();
});

it.each([false, true])('single failed/zero-row insert never sends a success receipt (zero=%s)', async (zero) => {
  db.failures.push({ table: 'transactions', mode: 'insert', zero });
  await expect(createTxn({ action: 'CREATE_TRANSACTION', payload }, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.transactions).toHaveLength(1);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('missing optional description stays empty while required create fields stay explicit', async () => {
  await createTxn({ action: 'CREATE_TRANSACTION', payload: { amount: '12.5', type: 'income', date: '2024-02-29' } }, account, msg, 'en');
  expect(db.tables.transactions[1]).toMatchObject({amount:'12.50',type:'income',date:'2024-02-29',description:'',category_id:incomeId});
  expect(state.sendWA.mock.calls[0][1]).toContain('+Rp12,50');
  expect(state.sendWA.mock.calls[0][1]).toContain('Tips');
});
it('duplicate presentation labels do not make exact ID selection ambiguous', async () => {
  db.tables.categories.push({...db.tables.categories[0],id:'20000000-0000-4000-8000-000000000005'});
  await createTxn({action:'CREATE_TRANSACTION',payload},account,msg,'en');
  expect(db.tables.transactions[1].category_id).toBe(expenseId);
});
it('member attribution read outage prevents an unverified financial write', async () => {
  db.failures.push({ table: 'members', mode: 'read' });
  await expect(createTxn({ action: 'CREATE_TRANSACTION', payload }, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.transactions).toHaveLength(1);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('foreign transaction cannot be edited through a local account', async () => {
  db.tables.transactions[0].account_id = foreignAccountId;
  const before = structuredClone(db.tables.transactions);
  await expect(editTxn({ action: 'EDIT_TRANSACTION', payload: { amount: '99.00' } }, txnId, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.transactions).toEqual(before);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('type/category edit validates the final merged state and uses saved income category', async () => {
  await editTxn({ action: 'EDIT_TRANSACTION', payload: { type: 'income', category_id: incomeId, amount: '12.5' } }, txnId, account, msg, 'en');
  expect(db.tables.transactions[0]).toMatchObject({ type: 'income', amount: '12.50', category_id: incomeId, edited_by_name: 'A' });
  expect(state.sendWA.mock.calls[0][1]).toContain('+Rp12,50');
  expect(state.sendWA.mock.calls[0][1]).toContain('Tips');
});
it('explicit null category removes the stored category and renders uncategorized', async () => {
  await editTxn({ action: 'EDIT_TRANSACTION', payload: { category_id: null } }, txnId, account, msg, 'en');
  expect(db.tables.transactions[0].category_id).toBeNull();
  expect(state.sendWA.mock.calls[0][1]).toContain(t.en.uncategorized);
  expect(state.sendWA.mock.calls[0][1]).not.toContain('Food');
});
it('zero-row receipt-ID update is observable, not a second financial write', async () => {
  db.failures.push({ table: 'transactions', mode: 'update', zero: true });
  await expect(createTxn({ action: 'CREATE_TRANSACTION', payload }, account, msg, 'en')).rejects.toBeInstanceOf(BotDeliveryError);
  expect(db.tables.transactions).toHaveLength(2);
  expect(db.tables.transactions[0].wa_bot_message_id).toBe('old-receipt');
  expect(db.tables.transactions[1].wa_bot_message_id).toBeUndefined();
  expect(db.writes.filter((row) => row.table === 'transactions' && row.mode === 'insert')).toHaveLength(1);
});
it('empty provider receipt ID never binds a transaction and never repeats the insert', async () => {
  state.sendWA.mockResolvedValueOnce({ kind: 'uncertain', code: 'missing_provider_id' });
  await expect(createTxn({ action: 'CREATE_TRANSACTION', payload }, account, msg, 'en')).rejects.toBeInstanceOf(BotDeliveryError);
  expect(db.tables.transactions).toHaveLength(2);
  expect(db.tables.transactions[1].wa_bot_message_id).toBeUndefined();
});
it('budget lookup outage appends a warning limitation to an honest committed receipt', async () => {
  db.failures.push({ table: 'budgets', mode: 'read' });
  await createTxn({ action: 'CREATE_TRANSACTION', payload }, account, msg, 'en');
  expect(db.tables.transactions[1]).toMatchObject({ amount: '35.50', wa_bot_message_id: 'new-receipt' });
  expect(state.sendWA.mock.calls[0][1]).toContain('Rp35,50');
  expect(state.sendWA.mock.calls[0][1]).toContain(t.en.budgetWarningUnavailable);
});
it('a category insert sends a receipt from the saved name/type', async () => {
  await addCategory({action:'ADD_CATEGORY',payload:{category_name:' Travel ',category_type:'expense',category_language:'en'}},account,msg,'en');
  expect(db.tables.categories.at(-1)).toMatchObject({account_id:accountId,name_en:'Travel',name_id:null,type:'expense',is_custom:true,is_active:true});
  expect(state.sendWA.mock.calls[0][1]).toBe(t.en.categoryAdded('Travel', 'expense'));
});
it('duplicate category is a conflict rather than an insertion or successful receipt', async () => {
  await expect(addCategory({ action: 'ADD_CATEGORY', payload: { category_name: ' food ', category_type: 'expense', category_language:'en' } }, account, msg, 'en')).rejects.toMatchObject({ kind: 'conflict' });
  expect(db.tables.categories).toHaveLength(4);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('category post-commit send failure is observable without repeating the save', async () => {
  state.sendWA.mockResolvedValueOnce({ kind: 'uncertain', code: 'transport_unknown' });
  await expect(addCategory({ action: 'ADD_CATEGORY', payload: { category_name: 'Travel', category_type: 'expense', category_language:'en' } }, account, msg, 'en')).rejects.toBeInstanceOf(BotDeliveryError);
  expect(db.tables.categories.at(-1)?.name_en).toBe('Travel');
  expect(db.writes.filter((row) => row.table === 'categories' && row.mode === 'insert')).toHaveLength(1);
});

it('creates an untranslated child under the exact selected root and renders its bilingual path',async()=>{
  await addCategory({action:'ADD_CATEGORY',payload:{category_name:'Warung',category_type:'expense',category_language:'id',parent_category_id:expenseId}},account,msg,'en');
  expect(db.tables.categories.at(-1)).toMatchObject({parent_id:expenseId,name_id:'Warung',name_en:null,type:'expense'});
  expect(state.sendWA.mock.calls[0][1]).toContain('Food / Warung');
});
it('description-only edits retain an inactive historical child and show its localized root path',async()=>{
  db.tables.categories.find(row=>row.id===inactiveId)!.parent_id=expenseId;
  db.tables.transactions[0].category_id=inactiveId;
  await editTxn({action:'EDIT_TRANSACTION',payload:{description:'Corrected historical meal'}},txnId,account,msg,'en');
  expect(db.tables.transactions[0]).toMatchObject({category_id:inactiveId,description:'Corrected historical meal',edited_by_name:'A'});
  expect(state.sendWA.mock.calls[0][1]).toContain('Food / Old food');
});
it('an inactive root prevents recording under an otherwise active child without any write',async()=>{
  const childId='20000000-0000-4000-8000-000000000011';
  db.tables.categories.push({...db.tables.categories[0],id:childId,parent_id:inactiveId,code:null});
  await expect(createTxn({action:'CREATE_TRANSACTION',payload:{...payload,category_id:childId}},account,msg,'en')).rejects.toMatchObject({kind:'invalid'});
  expect(db.writes).toEqual([]);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('all batch category choices validate before the first financial insert', async () => {
  await expect(createMultiple({ action: 'CREATE_MULTIPLE', payload: {},
    transactions: [payload, { ...payload, category_id: inactiveId }] }, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.transactions).toHaveLength(1);
  expect(db.writes).toEqual([]);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('batch success formats an exact decimal net total and binds all stored rows only', async () => {
  await createMultiple({ action: 'CREATE_MULTIPLE', payload: {}, transactions: [
    { ...payload, amount: '0.10' }, { ...payload, amount: '0.20' },
    { amount: '0.05', type: 'income', date: '2026-10-12', category_id: incomeId },
  ] }, account, msg, 'en');
  expect(db.tables.transactions.slice(1).map((row) => [row.amount, row.wa_bot_message_id])).toEqual([
    ['0.10', 'new-receipt'], ['0.20', 'new-receipt'], ['0.05', 'new-receipt'],
  ]);
  expect(db.tables.transactions[0].wa_bot_message_id).toBe('old-receipt');
  expect(state.sendWA.mock.calls[0][1]).toContain('Total: -Rp0,25');
  expect(state.sendWA.mock.calls[0][1]).not.toContain('0,2500000');
});
it('successful batch compensation removes only this request known rows', async () => {
  const foreign = { ...db.tables.transactions[0], id: '30000000-0000-4000-8000-000000000002', account_id: foreignAccountId };
  db.tables.transactions.push(foreign);
  const before = structuredClone(db.tables.transactions);
  db.failures.push({ table: 'transactions', mode: 'insert', skip: 1 });
  await expect(createMultiple({ action: 'CREATE_MULTIPLE', payload: {}, transactions: [payload, { ...payload, description: 'Taxi' }] }, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.transactions).toEqual(before);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('zero-row batch compensation reports only re-read committed rows', async () => {
  db.failures.push({ table: 'transactions', mode: 'insert', skip: 1 }, { table: 'transactions', mode: 'delete', zero: true });
  await createMultiple({ action: 'CREATE_MULTIPLE', payload: {}, transactions: [payload, { ...payload, description: 'Taxi' }] }, account, msg, 'en');
  expect(db.tables.transactions).toHaveLength(2);
  expect(state.sendWA.mock.calls[0][1]).toContain(t.en.batchPartial);
  expect(state.sendWA.mock.calls[0][1]).toContain('Lunch');
  expect(state.sendWA.mock.calls[0][1]).not.toContain('Taxi');
});
it('batch with failed rollback and unreadable outcome never fabricates a success receipt', async () => {
  db.failures.push({ table: 'transactions', mode: 'insert', skip: 1 }, { table: 'transactions', mode: 'delete' },
    { table: 'transactions', mode: 'read' });
  await createMultiple({ action: 'CREATE_MULTIPLE', payload: {}, transactions: [payload, { ...payload, description: 'Taxi' }] }, account, msg, 'en');
  expect(db.tables.transactions).toHaveLength(2);
  expect(state.sendWA.mock.calls[0][1]).toBe(t.en.batchOutcomeUnknown);
  expect(db.tables.transactions[1].wa_bot_message_id).toBeUndefined();
});

it('a concurrent correction cannot be overwritten by a description-only edit', async () => {
  const originalFrom = db.from.bind(db);
  let interleaved = false;
  vi.spyOn(db, 'from').mockImplementation((table) => {
    const query = originalFrom(table);
    if (table === 'transactions') {
      const update = query.update.bind(query);
      query.update = (values) => {
        if (!interleaved) {
          interleaved = true;
          db.tables.transactions[0].amount = '40.25';
        }
        return update(values);
      };
    }
    return query;
  });
  await expect(editTxn({ action: 'EDIT_TRANSACTION', payload: { description: 'Changed' } }, txnId, account, msg, 'en'))
    .rejects.toMatchObject({ kind: 'conflict' });
  expect(db.tables.transactions[0].amount).toBe('40.25');
  expect(state.sendWA).not.toHaveBeenCalled();
});
type EditRace = { name: string; category: string | null; correction: Row; payload: AIResponse['payload'] };
const editRaces: EditRace[] = [
  { name: 'category cleared', category: expenseId, correction: { category_id: null }, payload: { amount: '35.50' } },
  { name: 'category assigned from null', category: null, correction: { category_id: expenseId }, payload: { type: 'income' } },
  { name: 'type changed before category selection', category: null, correction: { type: 'income' }, payload: { category_id: expenseId } },
  { name: 'date corrected', category: expenseId, correction: { date: '2026-10-11' }, payload: { description: 'Changed' } },
  { name: 'description corrected', category: expenseId, correction: { description: 'Concurrent correction' }, payload: { amount: '35.50' } },
];
it.each(editRaces)('stale $name snapshot conflicts without financial write or receipt', async ({ category, correction, payload }) => {
  db.tables.transactions[0].category_id = category;
  db.tables.transactions[0].updated_at = '2026-10-12T00:00:00Z';
  const expected = { ...db.tables.transactions[0], ...correction };
  const originalFrom = db.from.bind(db);
  let interleaved = false;
  vi.spyOn(db, 'from').mockImplementation((table) => {
    const query = originalFrom(table);
    if (table === 'transactions') {
      const update = query.update.bind(query);
      query.update = (values) => {
        if (!interleaved) {
          interleaved = true;
          Object.assign(db.tables.transactions[0], correction);
        }
        return update(values);
      };
    }
    return query;
  });
  await expect(editTxn({ action: 'EDIT_TRANSACTION', payload }, txnId, account, msg, 'en'))
    .rejects.toMatchObject({ kind: 'conflict' });
  expect(interleaved).toBe(true);
  expect(db.tables.transactions).toEqual([expected]);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('deletion after the validated edit snapshot is a conflict without a receipt', async () => {
  const originalFrom = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table) => {
    const query = originalFrom(table);
    if (table === 'transactions') {
      const update = query.update.bind(query);
      query.update = (values) => { db.tables.transactions = []; return update(values); };
    }
    return query;
  });
  await expect(editTxn({ action: 'EDIT_TRANSACTION', payload: { description: 'Changed' } }, txnId, account, msg, 'en'))
    .rejects.toMatchObject({ kind: 'conflict' });
  expect(db.tables.transactions).toEqual([]);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('description-only edit retains an uncategorized transaction and reports its stored amount', async () => {
  db.tables.transactions[0].amount = 20;
  db.tables.transactions[0].category_id = null;
  await editTxn({ action: 'EDIT_TRANSACTION', payload: { description: '' } }, txnId, account, msg, 'en');
  expect(Number(db.tables.transactions[0].amount)).toBe(20);
  expect(db.tables.transactions[0]).toMatchObject({ description: '', category_id: null, edited_by_name: 'A', wa_bot_message_id: 'new-receipt' });
  expect(state.sendWA.mock.calls[0][1]).toContain('Rp20');
  expect(state.sendWA.mock.calls[0][1]).toContain(t.en.uncategorized);
});
