import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account, IncomingMessage, TxnForBot } from '../src/ai/types';
import { seedSecurityDb, txnId, accountId, foreignAccountId, expenseId, incomeId, type SecurityDb } from './helpers/securityDb';
import type { SendOutcome } from '../src/delivery/types';
const accepted = (providerMessageId: string): SendOutcome => ({ kind: 'accepted', providerMessageId });
const state = vi.hoisted(() => ({ db: null as unknown,
  sendWA: vi.fn<(to: string, text: string) => Promise<SendOutcome>>(), ai: vi.fn<(...args: unknown[]) => Promise<unknown>>() }));
vi.mock('../src/services/supabase', () => ({ supabase: new Proxy({}, { get: (_target, key) => {
  const db = state.db as SecurityDb; const value = db[key as keyof typeof db];
  return typeof value === 'function' ? value.bind(db) : value;
} }) }));
vi.mock('../src/services/whatsapp', () => ({ sendWA: state.sendWA }));
vi.mock('../src/ai', () => ({ callAI: state.ai }));
import { routeMessage } from '../src/router';
import { deleteTxn } from '../src/handlers/deleteTxn';
import { t } from '../src/i18n/bot';
let db: SecurityDb; let account: Account;
const base: IncomingMessage = { messageId: 'incoming-1', chatId: 'test-group', rawFrom: 'requester-A', text: 'test', repliedToId: null };
const txn: TxnForBot = { id: txnId, description: 'Existing', amount: '20.00', date: '2026-10-12', category_name: 'Food' };
beforeEach(() => {
  vi.stubEnv('DELETE_CONFIRMATIONS_ENABLED','true');
  db = seedSecurityDb(); state.db = db; account = db.tables.accounts[0] as unknown as Account;
  state.sendWA.mockReset().mockResolvedValue(accepted('prompt-1')); state.ai.mockReset().mockResolvedValue({ action: 'CREATE_TRANSACTION', payload: { amount: '999.00', type: 'expense', date: '2026-10-12' } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
it.each(['/summary','/search Lunch','/categories'])('read outage in %s is never an empty success',async(text)=>{
  db.failures.push({table:text==='/categories'?'categories':'transactions',mode:'read'});
  await routeMessage({...base,text});
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.dependencyUnavailable);
  expect(db.tables.transactions).toHaveLength(1); expect(state.ai).not.toHaveBeenCalled();
});
it.each([{ rawFrom: 'requester-B', repliedToId: 'prompt-1' }, { repliedToId: 'unrelated' }, { rawFrom: 'requester-B', repliedToId: null }])('wrong sender or unrelated confirmation %j cannot mutate', async (override) => {
  await deleteTxn(txn, account, base, 'en'); state.sendWA.mockClear();
  await routeMessage({ ...base, text: 'yes', ...override });
  expect(db.tables.transactions).toHaveLength(1); expect(db.tables.pending_actions).toHaveLength(1); expect(db.rpcCalls).toHaveLength(0);
  expect(state.ai).not.toHaveBeenCalled(); expect(state.sendWA.mock.calls[0][1]).toBe(t.en.confirmationUnsupported);
});
it('bound yes deletes through RPC; bound no preserves target', async () => {
  await deleteTxn(txn, account, base, 'en'); await routeMessage({ ...base, text: 'no', repliedToId: 'prompt-1' });
  expect(db.tables.transactions).toHaveLength(1); expect(db.tables.pending_actions).toHaveLength(0);
  await deleteTxn(txn, account, base, 'en'); await routeMessage({ ...base, text: 'yes', repliedToId: 'prompt-1' });
  expect(db.tables.transactions).toHaveLength(0); expect(db.rpcCalls).toHaveLength(2); expect(state.ai).not.toHaveBeenCalled();
});
it.each(['ya', 'yes'])('plain %s deletes only the requester target and cannot consume another sender on replay', async (answer) => {
  const otherId = '30000000-0000-4000-8000-000000000002';
  const other = { ...db.tables.transactions[0], id: otherId, description: 'Other transaction' };
  db.tables.transactions.push(other);
  state.sendWA.mockResolvedValueOnce(accepted('prompt-A')).mockResolvedValueOnce(accepted('prompt-B'));
  await deleteTxn(txn, account, base, 'en');
  await deleteTxn({ ...txn, id: otherId }, account, { ...base, rawFrom: 'requester-B' }, 'en');
  await routeMessage({ ...base, text: answer, repliedToId: null });
  expect(db.tables.transactions).toEqual([other]);
  expect(db.tables.pending_actions.map(row => [row.transaction_id, row.requested_by_phone, row.confirmation_message_id]))
    .toEqual([[otherId, 'requester-B', 'prompt-B']]);
  await routeMessage({ ...base, text: answer, repliedToId: null });
  expect(db.tables.transactions).toEqual([other]);
  expect(db.tables.pending_actions.map(row => row.requested_by_phone)).toEqual(['requester-B']);
  expect(state.ai).not.toHaveBeenCalled();
});
it.each(['tidak', 'no'])('plain %s cancels the requester deletion without changing its transaction', async (answer) => {
  const original = db.tables.transactions.map(row => ({ ...row }));
  await deleteTxn(txn, account, base, 'en');
  await routeMessage({ ...base, text: answer, repliedToId: null });
  expect(db.tables.transactions).toEqual(original);
  expect(db.tables.pending_actions).toEqual([]);
  expect(state.ai).not.toHaveBeenCalled();
});
it('plain ya cannot delete after the database confirmation lifetime', async () => {
  await deleteTxn(txn, account, base, 'en');
  db.clock = Date.now() + 120_000;
  await routeMessage({ ...base, text: 'ya', repliedToId: null });
  expect(db.tables.transactions.map(row => row.id)).toEqual([txnId]);
  expect(db.tables.pending_actions).toEqual([]);
});
it('plain ya cannot consume a prompt whose delivery has no provider ID', async () => {
  state.sendWA.mockResolvedValueOnce({ kind: 'uncertain', code: 'missing_provider_id' });
  await expect(deleteTxn(txn, account, base, 'en')).rejects.toThrow('Post-commit delivery failed');
  await routeMessage({ ...base, text: 'ya', repliedToId: null });
  expect(db.tables.transactions.map(row => row.id)).toEqual([txnId]);
  expect(db.tables.pending_actions.map(row => row.confirmation_message_id)).toEqual([null]);
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.confirmationUnsupported);
  expect(state.ai).not.toHaveBeenCalled();
});
it('non-decision reply to confirmation cannot be classified as a create', async () => {
  await deleteTxn(txn, account, base, 'en'); await routeMessage({ ...base, text: 'instead add 999', repliedToId: 'prompt-1' });
  expect(db.tables.transactions).toHaveLength(1); expect(state.ai).not.toHaveBeenCalled();
});
it('inactive linked account denies classification and consumption', async () => {
  await deleteTxn(txn, account, base, 'en'); db.tables.accounts[0].is_active = false;
  await routeMessage({ ...base, text: 'yes', repliedToId: 'prompt-1' });
  expect(db.tables.transactions).toHaveLength(1); expect(db.rpcCalls).toEqual([]); expect(state.ai).not.toHaveBeenCalled();
});
it('account outage is not an empty/not-setup success', async () => {
  db.failures.push({ table: 'accounts', mode: 'read' }); await routeMessage(base);
  expect(state.sendWA.mock.calls[0][1]).toBe(t.id.dependencyUnavailable); expect(state.ai).not.toHaveBeenCalled();
});
it('member preference outage uses the already-loaded English account locale', async () => {
  db.tables.accounts[0].language = 'en';
  db.tables.members[0].language_pref = 'id';
  db.failures.push({ table: 'members', mode: 'read' });
  await routeMessage(base);
  expect(state.sendWA).toHaveBeenCalledExactlyOnceWith(base.chatId, t.en.dependencyUnavailable);
  expect(state.ai).not.toHaveBeenCalled();
  expect(db.writes).toEqual([]);
});
it('a successful member preference read overrides the English account fallback', async () => {
  db.tables.members[0].language_pref = 'id';
  state.ai.mockResolvedValue({ action: 'CREATE_TRANSACTION', payload: {} });
  await routeMessage(base);
  expect(state.sendWA).toHaveBeenCalledExactlyOnceWith(base.chatId, t.id.invalidCommand);
  expect(db.writes).toEqual([]);
});
it.each(['id', 'en'] as const)('invalid model creation returns %s correction without write', async (language) => {
  db.tables.accounts[0].language = language; state.ai.mockResolvedValue({ action: 'CREATE_TRANSACTION', payload: {} });
  await routeMessage(base); expect(db.tables.transactions).toHaveLength(1); expect(db.writes).toEqual([]);
  expect(state.sendWA.mock.calls[0][1]).toBe(t[language].invalidCommand);
});
it('unknown/non-mutating model action cannot write financial data', async () => {
  state.ai.mockResolvedValue({ action: 'NUKE_EVERYTHING', payload: { amount: 99 }, reply: 'hello' });
  await routeMessage(base); expect(db.writes).toEqual([]); expect(state.sendWA.mock.calls[0][1]).toBe('hello');
});
it('edit without a transaction reply cannot alter financial records', async () => {
  const before = structuredClone(db.tables.transactions);
  state.ai.mockResolvedValue({ action: 'EDIT_TRANSACTION', payload: { description: 'Changed' } });
  await routeMessage(base);
  expect(db.tables.transactions).toEqual(before); expect(db.writes).toEqual([]);
});
it.each([false, true])('failed/zero-row language change preserves preference and never sends success (zero=%s)', async (zero) => {
  db.failures.push({ table: 'members', mode: 'update', zero }); await routeMessage({ ...base, text: '/language id' });
  expect(db.tables.members[0].language_pref).toBeNull();
  expect(state.sendWA.mock.calls.some((call) => call[1] === t.id.langChanged('id'))).toBe(false);
});
it('successful language outcome reflects stored preference', async () => {
  await routeMessage({ ...base, text: '/language id' }); expect(db.tables.members[0].language_pref).toBe('id');
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.id.langChanged('id'));
});
it('first language preference can be changed without duplicating membership', async () => {
  db.tables.members = [];
  const financialRows = db.tables.transactions.map(row => ({ ...row }));
  await routeMessage({ ...base, text: '/language id' });
  await routeMessage({ ...base, text: '/language en' });
  expect(db.tables.members).toEqual([expect.objectContaining({
    account_id: accountId, wa_phone: base.rawFrom, language_pref: 'en',
  })]);
  expect(db.tables.transactions).toEqual(financialRows);
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.langChanged('en'));
});
function seedLink() {
  db.tables.link_codes = [{ id: '50000000-0000-4000-8000-000000000001', account_id: account.id,
    code: 'TESTCODE', used: false, expires_at: new Date(Date.now() + 60_000).toISOString() }];
}
it.each([
  { table: 'link_codes', mode: 'read' as const }, { table: 'accounts', mode: 'update' as const },
  { table: 'link_codes', mode: 'update' as const }, { table: 'members', mode: 'read' as const },
  { table: 'members', mode: 'update' as const },
])('setup checks %j failure and never sends setup success', async (failure) => {
  seedLink(); db.failures.push(failure); await routeMessage({ ...base, text: '/setup TESTCODE en' });
  expect(state.sendWA.mock.calls.some((call) => call[1] === t.en.setupOk('Disposable account'))).toBe(false);
});
it.each(['accounts', 'link_codes', 'members'])('setup %s zero-row update is not success', async (table) => {
  seedLink(); db.failures.push({ table, mode: 'update', zero: true }); await routeMessage({ ...base, text: '/setup TESTCODE en' });
  expect(state.sendWA.mock.calls.some((call) => call[1] === t.en.setupOk('Disposable account'))).toBe(false);
});
it('setup member insert failure is checked', async () => {
  seedLink(); db.tables.members = []; db.failures.push({ table: 'members', mode: 'insert' });
  await routeMessage({ ...base, text: '/setup TESTCODE en' }); expect(db.tables.members).toHaveLength(0);
  expect(state.sendWA.mock.calls.some((call) => call[1] === t.en.setupOk('Disposable account'))).toBe(false);
});
it('inactive setup target cannot link or consume code', async () => {
  seedLink(); db.tables.accounts[0].is_active = false;
  await routeMessage({ ...base, chatId: 'new-chat', text: '/setup TESTCODE en' });
  expect(db.tables.accounts[0].wa_chat_id).toBe('test-group'); expect(db.tables.link_codes[0].used).toBe(false); expect(db.writes).toEqual([]);
});
it('setup success follows all checked outcomes', async () => {
  seedLink(); await routeMessage({ ...base, text: '/setup TESTCODE en' });
  expect(db.tables.link_codes[0].used).toBe(true); expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.setupOk('Disposable account'));
});
it('post-commit send failure stays observable and does not repeat insert', async () => {
  state.sendWA.mockResolvedValueOnce({ kind: 'uncertain', code: 'transport_unknown' });
  await expect(routeMessage(base)).rejects.toThrow('Post-commit delivery failed');
  expect(db.tables.transactions).toHaveLength(2); expect(state.sendWA).toHaveBeenCalledTimes(1);
});
it('transaction lookup outage cannot fall through to a new creation', async () => {
  db.failures.push({ table: 'transactions', mode: 'read' }); await routeMessage({ ...base, repliedToId: 'old-receipt' });
  expect(db.tables.transactions).toHaveLength(1); expect(state.ai).not.toHaveBeenCalled();
});
it('recognized transaction reply cannot turn create output into a new mutation', async () => {
  await routeMessage({ ...base, repliedToId: 'old-receipt' }); expect(db.tables.transactions).toHaveLength(1);
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.invalidCommand);
});

it.each(['yes', 'no', 'ya', 'tidak'])('stale %s after replacement cannot reach provider or consume the newer prompt', async (text) => {
  await deleteTxn(txn, account, base, 'en');
  state.sendWA.mockResolvedValueOnce(accepted('new-prompt'));
  await deleteTxn(txn, account, base, 'en');
  state.sendWA.mockClear();
  await routeMessage({ ...base, text, repliedToId: 'prompt-1' });
  expect(db.tables.pending_actions[0].confirmation_message_id).toBe('new-prompt');
  expect(db.tables.transactions.map((row) => row.id)).toEqual([txnId]);
  expect(db.rpcCalls).toEqual([]);
  expect(state.ai).not.toHaveBeenCalled();
  expect(state.sendWA.mock.calls[0][1]).toBe(t.en.confirmationUnsupported);
});
it('expired confirmation is evaluated by persisted RPC state without AI fallback', async () => {
  await deleteTxn(txn, account, base, 'en');
  db.clock = Date.now() + 120_000;
  await routeMessage({ ...base, text: 'yes', repliedToId: 'prompt-1' });
  expect(db.tables.transactions.map((row) => row.id)).toEqual([txnId]);
  expect(db.tables.pending_actions).toEqual([]);
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.confirmationExpired);
  expect(state.ai).not.toHaveBeenCalled();
});
it('duplicate confirmation cannot create or delete again', async () => {
  await deleteTxn(txn, account, base, 'en');
  await routeMessage({ ...base, text: 'yes', repliedToId: 'prompt-1' });
  await routeMessage({ ...base, text: 'yes', repliedToId: 'prompt-1' });
  expect(db.tables.transactions).toEqual([]);
  expect(db.rpcCalls).toHaveLength(1);
  expect(state.sendWA.mock.calls.filter((call) => call[1] === t.en.txnDeleted)).toHaveLength(1);
  expect(state.ai).not.toHaveBeenCalled();
});
it('confirmation lookup outage never falls through to provider mutation', async () => {
  await deleteTxn(txn, account, base, 'en');
  db.failures.push({ table: 'pending_actions', mode: 'read' });
  await routeMessage({ ...base, text: 'yes', repliedToId: 'prompt-1' });
  expect(db.tables.transactions).toHaveLength(1);
  expect(db.tables.pending_actions).toHaveLength(1);
  expect(db.rpcCalls).toEqual([]);
  expect(state.ai).not.toHaveBeenCalled();
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.dependencyUnavailable);
});
it('default-disabled rollout reserves confirmations and creates no pending row', async () => {
  vi.stubEnv('DELETE_CONFIRMATIONS_ENABLED', '');
  state.ai.mockResolvedValue({ action: 'DELETE_TRANSACTION', payload: {} });
  await routeMessage({ ...base, text: 'delete', repliedToId: 'old-receipt' });
  await routeMessage({ ...base, text: 'yes', repliedToId: 'prompt-1' });
  expect(db.tables.pending_actions).toEqual([]);
  expect(db.tables.transactions).toHaveLength(1);
  expect(db.rpcCalls.filter(call => call.name === 'consume_delete_confirmation')).toEqual([]);
  expect(state.ai).toHaveBeenCalledTimes(1);
});
it('account deactivation while provider is outstanding blocks the late financial write', async () => {
  state.ai.mockImplementationOnce(async () => {
    db.tables.accounts[0].is_active = false;
    return { action: 'CREATE_TRANSACTION', payload: { amount: '35', type: 'expense', date: '2026-10-12' } };
  });
  await routeMessage(base);
  expect(db.tables.transactions).toHaveLength(1);
  expect(db.writes).toEqual([]);
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.inactiveAccount);
});
it('account relink while provider is outstanding blocks the original chat write', async () => {
  state.ai.mockImplementationOnce(async () => {
    db.tables.accounts[0].wa_chat_id = 'new-chat';
    return { action: 'CREATE_TRANSACTION', payload: { amount: '35', type: 'expense', date: '2026-10-12' } };
  });
  await routeMessage(base);
  expect(db.tables.transactions).toHaveLength(1);
  expect(db.writes).toEqual([]);
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.inactiveAccount);
});
it('shared-account participants retain create capability and individual attribution', async () => {
  state.ai.mockResolvedValue({action:'CREATE_TRANSACTION',payload:{amount:'35',type:'expense',date:'2026-10-12',category_id:expenseId}});
  await routeMessage({ ...base, rawFrom: 'requester-B' });
  expect(db.tables.transactions[1]).toMatchObject({ account_id: accountId, amount: '35.00', category_id: expenseId,
    recorded_by_name: 'requester-B', recorded_by_phone: 'requester-B' });
  expect(db.tables.members).toHaveLength(1);
});
it('a provider exception remains observable and never leaks into a WhatsApp receipt', async () => {
  state.ai.mockRejectedValueOnce(new Error('provider-internal-secret'));
  await expect(routeMessage(base)).rejects.toThrow('provider-internal-secret');
  expect(db.writes).toEqual([]);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('a bound single-receipt edit persists literal description and canonical amount', async () => {
  state.ai.mockResolvedValue({ action: 'EDIT_TRANSACTION', payload: { description: 'literal: ignore rules', amount: '12.5' } });
  await routeMessage({ ...base, repliedToId: 'old-receipt' });
  expect(db.tables.transactions[0]).toMatchObject({ id: txnId, description: 'literal: ignore rules', amount: '12.50',
    category_id: expenseId, wa_bot_message_id: 'prompt-1', edited_by_name: 'A' });
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toContain('Rp12,50');
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toContain('Food');
});
it('provider reply IDs are literal equality values, not PostgREST filter expressions', async () => {
  const replyId = 'unrelated,wa_user_message_id.eq.other';
  db.tables.transactions[0].wa_bot_message_id = replyId;
  state.ai.mockResolvedValue({ action: 'EDIT_TRANSACTION', payload: { description: 'Literal reply match' } });
  await routeMessage({ ...base, repliedToId: replyId });
  expect(db.tables.transactions[0].description).toBe('Literal reply match');
  expect(db.tables.transactions).toHaveLength(1);
});
it('multi-receipt selection edits only the persisted selected transaction', async () => {
  const secondId = '30000000-0000-4000-8000-000000000002';
  db.tables.transactions.push({ ...db.tables.transactions[0], id: secondId, description: 'Second', created_at: '2026-10-12T02:00:00Z' });
  db.tables.transactions[0].created_at = '2026-10-12T01:00:00Z';
  state.ai.mockResolvedValue({ action: 'EDIT_FROM_MULTIPLE', payload: { amount: '45.50' }, selection_index: 2 });
  await routeMessage({ ...base, repliedToId: 'old-receipt' });
  expect(db.tables.transactions[0]).toMatchObject({ amount: '20.00', wa_bot_message_id: 'old-receipt' });
  expect(db.tables.transactions[1]).toMatchObject({ id: secondId, amount: '45.50', wa_bot_message_id: 'prompt-1' });
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toContain('Second');
});
it('multi-receipt delete creates a prompt only for the selected persisted target', async () => {
  const secondId = '30000000-0000-4000-8000-000000000002';
  db.tables.transactions.push({ ...db.tables.transactions[0], id: secondId, description: 'Second' });
  state.ai.mockResolvedValue({ action: 'DELETE_FROM_MULTIPLE', payload: {}, selection_index: 2 });
  await routeMessage({ ...base, repliedToId: 'old-receipt' });
  expect(db.tables.pending_actions[0]).toMatchObject({ transaction_id: secondId, requested_by_phone: 'requester-A', confirmation_message_id: 'prompt-1' });
  expect(db.tables.transactions).toHaveLength(2);
  await routeMessage({ ...base, text: 'yes', repliedToId: 'prompt-1' });
  expect(db.tables.transactions.map((row) => row.id)).toEqual([txnId]);
});
it.each([
  { action: 'EDIT_FROM_MULTIPLE', payload: { description: 'Changed' }, selection_index: 3 },
  { action: 'DELETE_FROM_MULTIPLE', payload: {}, selection_index: 0 },
  { action: 'CREATE_TRANSACTION', payload: { amount: 99, type: 'expense', date: '2026-10-12' } },
])('invalid/unrelated multi-receipt action %j cannot mutate or reclassify', async (output) => {
  db.tables.transactions.push({ ...db.tables.transactions[0], id: '30000000-0000-4000-8000-000000000002', description: 'Second' });
  const before = structuredClone(db.tables.transactions);
  state.ai.mockResolvedValue(output);
  await routeMessage({ ...base, repliedToId: 'old-receipt' });
  expect(db.tables.transactions).toEqual(before);
  expect(db.writes).toEqual([]);
  expect(state.ai).toHaveBeenCalledTimes(1);
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.invalidCommand);
});
it('slash summary renders account-scoped report totals without foreign data', async () => {
  db.rpcResponses.finance_summary = {
    income: '0.00', expense: '20.00', net: '-20.00',
    categories:[{id:expenseId,name_id:'Food',name_en:'Food',amount:'20.00'}],
    spendingByCategoryId:{[expenseId]:'20.00'},categoryDetails:[],byMonth:{},topExpenses:[],topIncomes:[],
  };
  vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
  db.tables.transactions.push({ ...db.tables.transactions[0], id: '30000000-0000-4000-8000-000000000002',
    account_id: foreignAccountId, amount: '999.00', description: 'Foreign secret' });
  await routeMessage({ ...base, text: '/summary' });
  const reply = state.sendWA.mock.calls.at(-1)?.[1];
  expect(reply).toContain('Expense : -Rp20');
  expect(reply).toContain('Food');
  expect(reply).not.toContain('999');
  expect(db.rpcCalls).toContainEqual({ name: 'finance_summary', args: {
    p_account_id: accountId, p_from: '2026-10-01', p_to: '2026-10-12',
  } });
  expect(state.ai).not.toHaveBeenCalled();
  expect(db.writes).toEqual([]);
});
it('search reads stored local history without foreign records', async () => {
  db.tables.transactions.push({ ...db.tables.transactions[0], id: '30000000-0000-4000-8000-000000000002',
    account_id: foreignAccountId, description: 'Existing foreign', amount: '999.00' });
  await routeMessage({ ...base, text: '/search Existing' });
  const reply = state.sendWA.mock.calls.at(-1)?.[1];
  expect(reply).toContain('Existing');
  expect(reply).toContain('Food');
  expect(reply).not.toContain('Existing foreign');
  expect(state.ai).not.toHaveBeenCalled();
  expect(db.writes).toEqual([]);
});
it('category slash response lists only active local category data', async () => {
  await routeMessage({ ...base, text: '/categories' });
  const reply = state.sendWA.mock.calls.at(-1)?.[1];
  expect(reply).toContain('Food');
  expect(reply).toContain('Tips');
  expect(reply).not.toContain('Old food');
  expect(reply).not.toContain('Foreign food');
  expect(db.writes).toEqual([]);
  expect(state.ai).not.toHaveBeenCalled();
});
it('help reply executes an RPC-backed summary without provider classification', async () => {
  db.rpcResponses.load_bot_help_context = true;
  db.rpcResponses.finance_summary = {
    income: '0.00', expense: '20.00', net: '-20.00',
    categories:[{id:expenseId,name_id:'Food',name_en:'Food',amount:'20.00'}],
    spendingByCategoryId:{[expenseId]:'20.00'},categoryDetails:[],byMonth:{},topExpenses:[],topIncomes:[],
  };
  vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
  state.sendWA.mockResolvedValueOnce(accepted('help-prompt'));
  await routeMessage({ ...base, text: '/help' });
  await routeMessage({ ...base, text: '1', repliedToId: 'help-prompt' });
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toContain('Expense : -Rp20');
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toContain('Food');
  expect(state.ai).not.toHaveBeenCalled();
  expect(db.writes).toEqual([]);
});
it('salary slash summary retains requested-month marker selection on persisted history', async () => {
  db.rpcResponses.finance_summary = {
    income: '100.00', expense: '20.00', net: '80.00',
    categories:[{id:expenseId,name_id:'Food',name_en:'Food',amount:'20.00'}],
    spendingByCategoryId:{[expenseId]:'20.00'},categoryDetails:[],byMonth:{},topExpenses:[],topIncomes:[],
  };
  vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
  Object.assign(db.tables.categories.find(row=>row.id===incomeId)!,{code:'salary',name_id:'Gaji',name_en:'Salary'});
  db.tables.transactions = [
    { ...db.tables.transactions[0], date: '2026-09-26' },
    { ...db.tables.transactions[0], id: '30000000-0000-4000-8000-000000000002', type: 'income', amount: '100.00',
      date: '2026-09-25', category_id: incomeId },
    { ...db.tables.transactions[0], id: '30000000-0000-4000-8000-000000000003', type: 'income', amount: '200.00',
      date: '2026-10-05', category_id: incomeId },
  ];
  await routeMessage({ ...base, text: '/summary salary sep 2026' });
  const reply = state.sendWA.mock.calls.at(-1)?.[1];
  expect(reply).toContain('Summary Since Salary 2026-09-25 to 2026-10-04');
  expect(reply).toContain('Income  : +Rp100');
  expect(reply).toContain('Expense : -Rp20');
  expect(state.ai).not.toHaveBeenCalled();
  expect(db.writes).toEqual([]);
  expect(db.rpcCalls).toContainEqual({ name: 'finance_summary', args: {
    p_account_id: accountId, p_from: '2026-09-25', p_to: '2026-10-04',
  } });
});
it('salary marker read outage is a dependency failure, not missing salary', async () => {
  Object.assign(db.tables.categories.find(row => row.id === incomeId)!, { code: 'salary' });
  db.failures.push({ table: 'transactions', mode: 'read' });
  await routeMessage({ ...base, text: '/summary salary' });
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.dependencyUnavailable);
  expect(state.ai).not.toHaveBeenCalled();
  expect(db.writes).toEqual([]);
});
