import { afterAll, expect, it } from 'vitest';
import { assertDisposableDatabase, initializeFixture, closeFixture, seedLinkedFixture, sql } from './helpers/phase2Db';

afterAll(closeFixture);

it.each([
  'postgres://x:x@db.example/finance_phase2_test',
  'postgres://x:x@127.0.0.1/postgres',
  'postgres://x:x@127.0.0.1/finance_phase2_test-other',
  'https://127.0.0.1/finance_phase2_test',
])('refuses unsafe fixture destination %s', (url) => {
  expect(() => assertDisposableDatabase(url)).toThrow('Refusing non-local disposable database');
});

it('creates linked disposable accounts with isolated membership and exact amounts', async () => {
  await initializeFixture();
  const f = await seedLinkedFixture();
  const rows = await sql<{ user_id: string; role: string }>(
    'select user_id,role from public.members where account_id=$1 order by role', [f.accountId]);
  expect(rows).toEqual([{ user_id: f.memberId, role: 'member' }, { user_id: f.ownerId, role: 'owner' }]);
  const [account] = await sql<{ wa_chat_id: string; is_active: boolean }>(
    'select wa_chat_id,is_active from public.accounts where id=$1', [f.accountId]);
  expect(account).toEqual({ wa_chat_id: f.chatId, is_active: true });
  await sql('insert into public.transactions(account_id,category_id,amount,type,date) values($1,$2,$3,$4,$5)',
    [f.accountId, f.categoryId, '9999999999999.99', 'expense', '2026-10-13']);
  const [transaction] = await sql<{ amount: string }>('select amount::text from public.transactions where account_id=$1', [f.accountId]);
  expect(transaction.amount).toBe('9999999999999.99');
});
