import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyPhase2MigrationsThrough, closeFixture, initializeFixture, seedLinkedFixture, sql, sqlAs } from './helpers/phase2Db';
import type { Fixture } from './helpers/phase2Db';

type Snapshot = { id: string; count: number; expiresAt: string; pageSize: number; code?: string };
type ExportRow = {
  ordinal: number;
  transactionId: string;
  date: string;
  description: string;
  category: string;
  type: string;
  amount: string;
};
type Page = { rows: ExportRow[]; code?: string };
type ExportFilters = {
  accountId: string;
  from: string | null;
  to: string | null;
  type: 'income' | 'expense' | null;
  categoryId: string | null;
  search: string | null;
};
const filters = (accountId: string): ExportFilters => ({
  accountId, from: '2026-10-01', to: '2026-10-31', type: null,
  categoryId: null, search: null,
});

beforeAll(async () => {
  await initializeFixture();
  await applyPhase2MigrationsThrough('202610130006_export_snapshots.sql');
});
afterAll(closeFixture);

async function start(f: Fixture, userId = f.memberId, selectedFilters: ExportFilters = filters(f.accountId)): Promise<Snapshot> {
  const [row] = await sql<{ value: Snapshot }>(
    'select public.start_finance_export($1,$2::jsonb) as value', [userId, JSON.stringify(selectedFilters)],
  );
  return row.value;
}
async function readPage(userId: string, exportId: string, after: number): Promise<Page> {
  const [row] = await sql<{ value: Page }>(
    'select public.read_finance_export($1,$2,$3,500) as value', [userId, exportId, after],
  );
  return row.value;
}

it('paginates an immutable 1,501-row snapshot despite transaction mutations', async () => {
  const f = await seedLinkedFixture();
  const secondCategory = randomUUID();
  await sql("insert into public.categories(id,account_id,name,type) values($1,$2,'Makanan','expense')", [secondCategory, f.accountId]);
  const ids = Array.from({ length: 1501 }, () => randomUUID());
  await sql(`insert into public.transactions(id,account_id,category_id,amount,type,description,date)
    select transaction_id,$2,
      case when row_number() over(order by transaction_id) = 1 then $3::uuid
           when row_number() over(order by transaction_id) = 2 then $4::uuid
           when row_number() over(order by transaction_id) = 3 then null else $3::uuid end,
      case when row_number() over(order by transaction_id) = 1 then 9999999999999.99 else 0.01 end,
      'expense',case when row_number() over(order by transaction_id) = 4 then '=SUM(A1:A2)' else 'row ' || transaction_id::text end,
      '2026-10-10'
    from unnest($1::uuid[]) as transaction_id`, [ids, f.accountId, f.categoryId, secondCategory]);
  const snapshot = await start(f);
  expect(snapshot).toMatchObject({ count: 1501, pageSize: 500 });

  const firstPage = await readPage(f.memberId, snapshot.id, 0);
  expect(firstPage.rows).toHaveLength(500);
  const expectedIds = (await sql<{ id: string }>(
    'select id from public.transactions where account_id=$1 order by date desc,created_at desc,id desc', [f.accountId],
  )).map(row => row.id);
  expect(firstPage.rows.map(row => row.transactionId)).toEqual(expectedIds.slice(0, 500));
  const originalTarget = firstPage.rows[0];
  const deletedTarget = (await readPage(f.memberId, snapshot.id, 500)).rows[0];
  await sql('update public.transactions set description=$1,amount=2.00,category_id=$2 where id=$3', ['changed later', secondCategory, originalTarget.transactionId]);
  await sql('delete from public.transactions where id=$1', [deletedTarget.transactionId]);
  await sql(`insert into public.transactions(account_id,category_id,amount,type,description,date)
    values($1,$2,9.99,'expense','added later','2026-10-10')`, [f.accountId, f.categoryId]);

  const pages: ExportRow[] = [...firstPage.rows];
  let after = firstPage.rows.at(-1)!.ordinal;
  while (after < snapshot.count) {
    const page = await readPage(f.memberId, snapshot.id, after);
    expect(page.code).toBeUndefined();
    expect(page.rows.length).toBeGreaterThan(0);
    pages.push(...page.rows);
    after = page.rows.at(-1)!.ordinal;
  }
  expect(pages).toHaveLength(1501);
  expect(pages.map(row => row.transactionId)).toEqual(expectedIds);
  expect(pages.find(row => row.transactionId === originalTarget.transactionId)).toMatchObject({
    description: originalTarget.description, amount: originalTarget.amount, category: originalTarget.category,
  });
  expect(pages.find(row => row.transactionId === deletedTarget.transactionId)).toMatchObject({
    description: deletedTarget.description, amount: deletedTarget.amount, category: deletedTarget.category,
  });
  expect(pages.find(row => row.amount === '9999999999999.99')?.amount).toBe('9999999999999.99');
  expect(pages.find(row => row.description === '=SUM(A1:A2)')?.description).toBe('=SUM(A1:A2)');
  expect(pages.filter(row => row.category === 'Makanan')).toHaveLength(1500);
  expect(pages.find(row => row.category === '—')).toBeDefined();
  const [released] = await sql<{ value: boolean }>('select public.release_finance_export($1,$2) as value', [f.memberId, snapshot.id]);
  expect(released.value).toBe(true);
});

it('keeps table filter semantics and denies export starts for nonmembers', async () => {
  const f = await seedLinkedFixture();
  const secondCategory = randomUUID(), incomeCategory = randomUUID();
  await sql(`insert into public.categories(id,account_id,name,type)
    values($1,$3,'Makanan','expense'),($2,$3,'Gaji','income')`,
    [secondCategory, incomeCategory, f.accountId]);
  await sql(`insert into public.transactions(account_id,category_id,amount,type,description,date)
    values($1,$2,1,'expense','meal at coffee','2026-10-10'),
          ($1,$3,1,'expense','meal at mall','2026-10-10'),
          ($1,$4,1,'income','meal refund','2026-10-10'),
          ($1,$2,1,'expense','meal next month','2026-11-01'),
          ($1,$2,1,'expense','dinner','2026-10-10')`,
    [f.accountId, f.categoryId, secondCategory, incomeCategory]);
  const snapshot = await start(f, f.memberId, {
    accountId: f.accountId, from: '2026-10-01', to: '2026-10-31',
    type: 'expense', categoryId: f.categoryId, search: 'meal%',
  });
  expect(snapshot.count).toBe(1);
  expect((await readPage(f.memberId, snapshot.id, 0)).rows[0].description).toBe('meal at coffee');
  const [released] = await sql<{ value: boolean }>(
    'select public.release_finance_export($1,$2) as value', [f.memberId, snapshot.id],
  );
  expect(released.value).toBe(true);
  expect(await start(f, randomUUID())).toMatchObject({ code: 'forbidden' });
});

it('rechecks membership before reading a page', async () => {
  const f = await seedLinkedFixture();
  await sql(`insert into public.transactions(account_id,category_id,amount,type,description,date)
    values($1,$2,1,'expense','member row','2026-10-10')`, [f.accountId, f.categoryId]);
  const snapshot = await start(f);
  await sql('delete from public.members where account_id=$1 and user_id=$2', [f.accountId, f.memberId]);
  expect(await readPage(f.memberId, snapshot.id, 0)).toMatchObject({ code: 'forbidden' });
});

it('reports expired snapshots and denies direct browser access to snapshot tables', async () => {
  const f = await seedLinkedFixture();
  const snapshot = await start(f);
  await sql("update public.finance_export_snapshots set expires_at=clock_timestamp()-interval '1 second' where id=$1", [snapshot.id]);
  expect(await readPage(f.memberId, snapshot.id, 0)).toMatchObject({ code: 'expired' });
  await expect(sqlAs('authenticated', 'select * from public.finance_export_snapshots')).rejects.toThrow();
});

it('rejects exports above the row cap before persisting snapshot rows', async () => {
  const f = await seedLinkedFixture();
  await sql(`insert into public.transactions(account_id,category_id,amount,type,description,date)
    select $1,$2,1.00,'expense','cap row','2026-10-12'::date from generate_series(1,100000)`,
    [f.accountId, f.categoryId]);

  expect(await start(f)).toMatchObject({ code: 'limit' });
  const [stored] = await sql<{ snapshots: string; rows: string }>(`select
    (select count(*)::text from public.finance_export_snapshots where account_id=$1) as snapshots,
    (select count(*)::text from public.finance_export_rows r join public.finance_export_snapshots s
      on s.id=r.snapshot_id where s.account_id=$1) as rows`, [f.accountId]);
  expect(stored).toEqual({ snapshots: '0', rows: '0' });
});
