import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyPhase2MigrationsThrough, closeFixture, initializeFixture, seedLinkedFixture, sql, sqlAs } from './helpers/phase2Db';
import type { Fixture } from './helpers/phase2Db';
type Report = {
  income: string;
  expense: string;
  net: string;
  categories: { id: string | null; name: string; amount: string }[];
  spendingByCategoryId: Record<string, string>;
  byMonth: Record<string, { income: string; expense: string }>;
  topExpenses: { id: string; amount: string; date: string; description: string; category: string }[];
  topIncomes: { id: string; amount: string; date: string; description: string; category: string }[];
};

beforeAll(async () => {
  await initializeFixture();
  await applyPhase2MigrationsThrough('202610130005_exact_reporting.sql');
});
afterAll(closeFixture);

async function summary(accountId: string, from = '2026-10-01', to = '2026-10-31'): Promise<Report> {
  const [row] = await sql<{ value: Report }>(
    'select public.finance_summary($1,$2::date,$3::date) as value', [accountId, from, to],
  );
  return row.value;
}

async function insertRows(f: Fixture, categoryId: string, count: number, amount = '0.01') {
  await sql(`insert into public.transactions(account_id,category_id,amount,type,description,date)
    select $1,$2,$3::numeric,'expense','small row','2026-10-10' from generate_series(1,$4)`,
    [f.accountId, categoryId, amount, count]);
}

it('aggregates more than the API row cap without merging same-label category IDs', async () => {
  const f = await seedLinkedFixture(), foreignAccount = await seedLinkedFixture(), secondCategory = randomUUID();
  await insertRows(foreignAccount, foreignAccount.categoryId, 1, '9999999999999.99');
  await sql("insert into public.categories(id,account_id,name,type) values($1,$2,'Makanan','expense')",
    [secondCategory, f.accountId]);
  await insertRows(f, f.categoryId, 1501);
  await sql(`insert into public.transactions(account_id,category_id,amount,type,description,date)
    values($1,$2,0.10,'expense','first same label','2026-10-11'),
          ($1,$3,0.20,'expense','second same label','2026-10-12'),
          ($1,null,0.01,'expense','uncategorized','2026-10-13'),
          ($1,$2,0.01,'income','small income','2026-10-14'),
          ($1,$2,0.01,'expense','outside range','2026-11-01')`,
    [f.accountId, f.categoryId, secondCategory]);
  const result = await summary(f.accountId);

  expect(result.income).toBe('0.01');
  expect(result.expense).toBe('15.32');
  expect(result.net).toBe('-15.31');
  expect(result.categories).toEqual(expect.arrayContaining([
    { id: f.categoryId, name: 'Makanan', amount: '15.11' },
    { id: secondCategory, name: 'Makanan', amount: '0.20' },
    { id: null, name: 'Other', amount: '0.01' },
  ]));
  expect(result.byMonth).toEqual({ '2026-10': { income: '0.01', expense: '15.32' } });
  const [budget] = await sql<{ value: { spendingByCategoryId: Record<string, string> } }>(
    'select public.finance_budget_spending($1,$2::date,$3::date) as value',
    [f.accountId, '2026-10-01', '2026-10-31'],
  );
  expect(budget.value.spendingByCategoryId).toEqual({
    [f.categoryId]: '15.11', [secondCategory]: '0.20',
  });
});

it('keeps totals beyond safe integer cents exact and chooses deterministic top-five IDs', async () => {
  const f = await seedLinkedFixture();
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await sql(`insert into public.transactions(id,account_id,category_id,amount,type,description,date)
    values($1,$6,$7,9999999999999.99,'expense','largest','2026-10-15'),
          ($2,$6,$7,9999999999999.99,'expense','second largest','2026-10-15'),
          ($3,$6,$7,100.05,'expense','five','2026-10-14'),
          ($4,$6,$7,100.04,'expense','four','2026-10-13'),
          ($5,$6,$7,100.03,'expense','three','2026-10-12'),
          ($8,$6,$7,100.02,'expense','two','2026-10-11'),
          ($9,$6,$7,100.01,'expense','one','2026-10-10')`,
    [...ids, f.accountId, f.categoryId, randomUUID(), randomUUID()]);
  const result = await summary(f.accountId);
  expect(result.expense).toBe('20000000000500.13');
  expect(result.net).toBe('-20000000000500.13');
  expect(result.topExpenses.map(row => row.id)).toEqual([ids[0], ids[1]].sort().concat(ids.slice(2)));
  expect(result.topExpenses.map(row => row.amount)).toEqual([
    '9999999999999.99', '9999999999999.99', '100.05', '100.04', '100.03',
  ]);
});

it('does not expose a category label from another account', async () => {
  const f = await seedLinkedFixture();
  const other = await seedLinkedFixture();
  const foreignCategoryId = randomUUID();
  await sql(`insert into public.categories(id,account_id,name,type)
    values($1,$2,'Private classification','expense')`, [foreignCategoryId, other.accountId]);
  await sql(`insert into public.transactions(account_id,category_id,amount,type,description,date)
    values($1,$2,17.25,'expense','cross-account category','2026-10-12')`, [f.accountId, foreignCategoryId]);

  const result = await summary(f.accountId);
  expect(result.categories).toContainEqual({ id: foreignCategoryId, name: 'Other', amount: '17.25' });
  expect(result.topExpenses).toContainEqual(expect.objectContaining({
    description: 'cross-account category', category: '—',
  }));
  expect(JSON.stringify(result)).not.toContain('Private classification');
});

it('does not expose report functions to authenticated database clients', async () => {
  const f = await seedLinkedFixture();
  await expect(sqlAs('authenticated','select public.finance_summary($1,$2::date,$3::date)',
    [f.accountId, '2026-10-01', '2026-10-31'])).rejects.toThrow();
});
