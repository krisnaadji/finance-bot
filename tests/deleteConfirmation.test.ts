import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account, IncomingMessage, PendingAction, TxnForBot } from '../src/ai/types';
import { seedSecurityDb, txnId, type SecurityDb } from './helpers/securityDb';
const state = vi.hoisted(() => ({ db: null as unknown, sendWA: vi.fn<(to: string, text: string) => Promise<string>>() }));
vi.mock('../src/services/supabase', () => ({ supabase: new Proxy({}, { get: (_target, key) => {
  const db = state.db as SecurityDb; const value = db[key as keyof typeof db];
  return typeof value === 'function' ? value.bind(db) : value;
} }) }));
vi.mock('../src/services/whatsapp', () => ({ sendWA: state.sendWA }));
import { deleteTxn, confirmDelete } from '../src/handlers/deleteTxn';
import { BotDeliveryError, BotWriteError } from '../src/handlers/transactionData';
import { t } from '../src/i18n/bot';
let db: SecurityDb; let account: Account;
const msg: IncomingMessage = { messageId: 'request-1', chatId: 'test-group', rawFrom: 'requester-A', text: 'delete', repliedToId: 'old-receipt' };
const txn: TxnForBot = { id: txnId, amount: '20.00', description: 'Existing', date: '2026-10-12', category_name: 'Food' };
beforeEach(() => { vi.stubEnv('DELETE_CONFIRMATIONS_ENABLED','true'); db = seedSecurityDb(); state.db = db; account = db.tables.accounts[0] as unknown as Account; state.sendWA.mockReset().mockResolvedValue('prompt-1'); });
afterEach(() => vi.unstubAllEnvs());
const pending = (): PendingAction => db.tables.pending_actions[0] as unknown as PendingAction;
it('disabled rollout cannot create a prompt or consume an existing action', async () => {
  await deleteTxn(txn,account,msg,'en'); const before={...pending()};
  vi.stubEnv('DELETE_CONFIRMATIONS_ENABLED','false');
  await confirmDelete({...msg,text:'yes',repliedToId:'prompt-1'},before,account,'en');
  await deleteTxn(txn,account,msg,'en');
  expect(db.tables.transactions).toHaveLength(1);
  expect(db.tables.pending_actions).toEqual([before]); expect(db.rpcCalls).toEqual([]);
});
it('different requesters coexist and replacements use fresh IDs for only their tuple', async () => {
  await deleteTxn(txn, account, msg, 'en'); const firstA = pending().id;
  state.sendWA.mockResolvedValueOnce('prompt-B'); await deleteTxn(txn, account, { ...msg, rawFrom: 'requester-B' }, 'en');
  const firstB = db.tables.pending_actions.find((row) => row.requested_by_phone === 'requester-B')!.id;
  state.sendWA.mockResolvedValueOnce('prompt-A2'); await deleteTxn(txn, account, msg, 'en');
  expect(db.tables.pending_actions).toHaveLength(2);
  expect(db.tables.pending_actions.find((row) => row.requested_by_phone === 'requester-A')!.id).not.toBe(firstA);
  expect(db.tables.pending_actions.find((row) => row.requested_by_phone === 'requester-B')!.id).toBe(firstB);
});
it('row is non-confirmable until provider send resolves and its ID persists', async () => {
  const send = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<void>();
  state.sendWA.mockImplementationOnce(() => { entered.resolve(); return send.promise; });
  const request = deleteTxn(txn, account, msg, 'en');
  await entered.promise;
  expect(pending().confirmation_message_id).toBeNull(); send.resolve('sent-prompt'); await request;
  expect(pending().confirmation_message_id).toBe('sent-prompt');
});
it('late old send cannot bind the replacement action', async () => {
  const send = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<void>();
  state.sendWA.mockImplementationOnce(() => { entered.resolve(); return send.promise; });
  const first = deleteTxn(txn, account, msg, 'en');
  const rejectedFirst = expect(first).rejects.toBeInstanceOf(BotWriteError);
  await entered.promise;
  state.sendWA.mockResolvedValueOnce('new-prompt'); await deleteTxn(txn, account, msg, 'en');
  send.resolve('old-prompt'); await rejectedFirst;
  expect(pending().confirmation_message_id).toBe('new-prompt');
});
it.each(['empty', 'throw'] as const)('failed prompt %s remains non-confirmable', async (mode) => {
  if (mode === 'empty') { state.sendWA.mockResolvedValueOnce(''); await deleteTxn(txn, account, msg, 'en'); }
  else { state.sendWA.mockRejectedValueOnce(new Error('send failed')); await expect(deleteTxn(txn, account, msg, 'en')).rejects.toBeInstanceOf(BotDeliveryError); }
  expect(pending().confirmation_message_id).toBeNull();
  await confirmDelete({ ...msg, text: 'yes', repliedToId: 'guessed-id' }, pending(), account, 'en');
  expect(db.rpcCalls).toEqual([]); expect(db.tables.transactions).toHaveLength(1);
});
it.each(['upsert', 'update'] as const)('pending %s write failure never gives a usable confirmation', async (mode) => {
  db.failures.push({ table: 'pending_actions', mode });
  await expect(deleteTxn(txn, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.pending_actions.every((row) => row.confirmation_message_id === null)).toBe(true);
});
it.each([{ rawFrom: 'requester-B' }, { chatId: 'other-chat' }, { repliedToId: 'unrelated' }])('wrong binding %j does not consume/delete', async (override) => {
  await deleteTxn(txn, account, msg, 'en');
  await confirmDelete({ ...msg, text: 'yes', repliedToId: 'prompt-1', ...override }, pending(), account, 'en');
  expect(db.rpcCalls).toEqual([]); expect(db.tables.pending_actions).toHaveLength(1); expect(db.tables.transactions).toHaveLength(1);
});
it('bound confirmation deletes only its target and replay reports no second deletion', async () => {
  await deleteTxn(txn, account, msg, 'en'); const row = { ...pending() };
  const other={...db.tables.transactions[0],id:'30000000-0000-4000-8000-000000000002',account_id:'10000000-0000-4000-8000-000000000002'};
  db.tables.transactions.push(other);
  await confirmDelete({ ...msg, text: 'yes', repliedToId: 'prompt-1' }, row, account, 'en');
  expect(db.tables.transactions).toEqual([other]);
  await confirmDelete({ ...msg, text: 'yes', repliedToId: 'prompt-1' }, row, account, 'en');
  expect(state.sendWA.mock.calls.filter((call) => call[1] === t.en.txnDeleted)).toHaveLength(1);
});
it('cancel consumes its action without deleting target', async () => {
  await deleteTxn(txn, account, msg, 'en'); await confirmDelete({ ...msg, text: 'no', repliedToId: 'prompt-1' }, pending(), account, 'en');
  expect(db.tables.pending_actions).toHaveLength(0); expect(db.tables.transactions).toHaveLength(1);
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.txnDeleteCancel);
});
it.each(['expired','target_missing','inactive'] as const)('%s cannot produce a deleted receipt',async(kind)=>{
  await deleteTxn(txn,account,msg,'en'); const row={...pending()};
  if(kind==='expired') db.clock=Date.now()+120000;
  else if(kind==='target_missing') db.tables.transactions=[];
  else db.tables.accounts[0].is_active=false;
  await confirmDelete({...msg,text:'yes',repliedToId:'prompt-1'},row,account,'en');
  expect(state.sendWA.mock.calls.some(call=>call[1]===t.en.txnDeleted)).toBe(false);
  if(kind!=='target_missing') expect(db.tables.transactions.map(record=>record.id)).toEqual([txnId]);
});
it('RPC failure leaves target/pending recoverable and does not report deletion', async () => {
  await deleteTxn(txn, account, msg, 'en'); db.rpcError = { code: '08006' };
  await expect(confirmDelete({ ...msg, text: 'yes', repliedToId: 'prompt-1' }, pending(), account, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.transactions).toHaveLength(1); expect(db.tables.pending_actions).toHaveLength(1);
  expect(state.sendWA.mock.calls.some((call) => call[1] === t.en.txnDeleted)).toBe(false);
});

it.each(['upsert', 'update'] as const)('pending %s zero-row write cannot create a usable binding', async (mode) => {
  db.failures.push({ table: 'pending_actions', mode, zero: true });
  await expect(deleteTxn(txn, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.transactions).toHaveLength(1);
  expect(db.tables.pending_actions.every((row) => row.confirmation_message_id === null)).toBe(true);
  expect(db.rpcCalls).toEqual([]);
});
it('delete prompt reloads canonical stored values instead of trusting the passed context', async () => {
  await deleteTxn({ ...txn, amount: '999.00', description: 'Fabricated', category_name: 'Invented' }, account, msg, 'en');
  const prompt = state.sendWA.mock.calls[0][1];
  expect(prompt).toContain('Existing');
  expect(prompt).toContain('Rp20');
  expect(prompt).toContain('Food');
  expect(prompt).not.toContain('Fabricated');
  expect(prompt).not.toContain('Invented');
  expect(prompt).not.toContain('999');
});
it('missing or foreign delete target cannot persist a prompt', async () => {
  const missing = '30000000-0000-4000-8000-000000000002';
  await expect(deleteTxn({ ...txn, id: missing }, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  db.tables.transactions[0].account_id = '10000000-0000-4000-8000-000000000002';
  await expect(deleteTxn(txn, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.pending_actions).toEqual([]);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('inactive and relinked accounts cannot start new destructive work', async () => {
  db.tables.accounts[0].is_active = false;
  await expect(deleteTxn(txn, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  db.tables.accounts[0].is_active = true;
  db.tables.accounts[0].wa_chat_id = 'new-chat';
  await expect(deleteTxn(txn, account, msg, 'en')).rejects.toBeInstanceOf(BotWriteError);
  expect(db.tables.pending_actions).toEqual([]);
  expect(state.sendWA).not.toHaveBeenCalled();
});
it('target deletion retires only its own obsolete prompts; unrelated targets survive', async () => {
  const otherId = '30000000-0000-4000-8000-000000000002';
  db.tables.transactions.push({ ...db.tables.transactions[0], id: otherId, description: 'Other' });
  await deleteTxn(txn, account, msg, 'en');
  const requestA = { ...pending() };
  state.sendWA.mockResolvedValueOnce('prompt-B');
  await deleteTxn(txn, account, { ...msg, rawFrom: 'requester-B' }, 'en');
  state.sendWA.mockResolvedValueOnce('prompt-C');
  await deleteTxn({ ...txn, id: otherId }, account, { ...msg, rawFrom: 'requester-C' }, 'en');
  await confirmDelete({ ...msg, text: 'yes', repliedToId: 'prompt-1' }, requestA, account, 'en');
  expect(db.tables.transactions.map((row) => row.id)).toEqual([otherId]);
  expect(db.tables.pending_actions.map((row) => [row.transaction_id, row.requested_by_phone, row.confirmation_message_id]))
    .toEqual([[otherId, 'requester-C', 'prompt-C']]);
});
it('cancelling one requester leaves another requester and the target intact', async () => {
  await deleteTxn(txn, account, msg, 'en');
  const requestA = { ...pending() };
  state.sendWA.mockResolvedValueOnce('prompt-B');
  await deleteTxn(txn, account, { ...msg, rawFrom: 'requester-B' }, 'en');
  await confirmDelete({ ...msg, text: 'no', repliedToId: 'prompt-1' }, requestA, account, 'en');
  expect(db.tables.transactions.map((row) => row.id)).toEqual([txnId]);
  expect(db.tables.pending_actions.map((row) => row.requested_by_phone)).toEqual(['requester-B']);
});
it('a post-consumption send failure leaves one committed deletion, without retrying it', async () => {
  await deleteTxn(txn, account, msg, 'en');
  const row = { ...pending() };
  state.sendWA.mockRejectedValueOnce(new Error('receipt transport down'));
  await expect(confirmDelete({ ...msg, text: 'yes', repliedToId: 'prompt-1' }, row, account, 'en')).rejects.toBeInstanceOf(BotDeliveryError);
  expect(db.tables.transactions).toEqual([]);
  expect(db.tables.pending_actions).toEqual([]);
  expect(db.rpcCalls).toHaveLength(1);
  await confirmDelete({ ...msg, text: 'yes', repliedToId: 'prompt-1' }, row, account, 'en');
  expect(state.sendWA.mock.calls.at(-1)?.[1]).toBe(t.en.confirmationHandled);
  expect(state.sendWA.mock.calls.filter((call) => call[1] === t.en.txnDeleted)).toHaveLength(1);
});
