import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyPhase2Migrations, applyPhase3MigrationsThrough, closeFixture, seedLinkedFixture, sql } from './helpers/phase2Db';
let accountId:string, ownerId:string, categoryId:string;
beforeAll(async()=>{
  await applyPhase2Migrations();
  const f=await seedLinkedFixture(), foreign=await seedLinkedFixture();
  ({accountId,ownerId,categoryId}=f);
  const [{id:salaryId}]=await sql<{id:string}>("select id from public.categories where account_id=$1 and type='income'",[accountId]);
  await sql(`insert into public.transactions(account_id,category_id,amount,type,date,description) values
    ($1,$2,10.01,'expense','2026-10-15','valid'),
    ($1,null,20.02,'expense','2026-10-15','uncategorized'),
    ($1,$3,30.03,'expense','2026-10-15','foreign reference'),
    ($1,$4,40.04,'expense','2026-10-15','wrong type reference')`,[accountId,categoryId,foreign.categoryId,salaryId]);
  await sql("update public.categories set name='Private foreign label' where id=$1",[foreign.categoryId]);
  await applyPhase3MigrationsThrough();
});
afterAll(closeFixture);
it('preserves incompatible legacy amounts in uncategorized totals and never exposes foreign or type-incompatible labels',async()=>{
  const [{v:summary}]=await sql<{v:{expense:string;spendingByCategoryId:Record<string,string>;categories:{id:string|null;amount:string}[];categoryDetails:{parentId:string|null;categoryId:string|null;amount:string}[]}}>(
    'select public.finance_summary($1,$2,$3) as v',[accountId,'2026-10-01','2026-10-31']);
  expect(summary.expense).toBe('100.10');
  expect(summary.spendingByCategoryId).toEqual({[categoryId]:'10.01'});
  expect(summary.categories).toEqual(expect.arrayContaining([expect.objectContaining({id:null,amount:'90.09'})]));
  expect(summary.categoryDetails).toContainEqual({parentId:null,categoryId:null,amount:'90.09'});
  const filters={accountId,locale:'en'};
  const [{v:view}]=await sql<{v:{total:number;rows:{description:string;categories:unknown;parent:unknown}[];summary:{expense:string}}}>(
    'select public.finance_transaction_view($1,$2,1,500) as v',[accountId,filters]);
  expect(view.total).toBe(4);expect(view.summary.expense).toBe(summary.expense);
  for(const row of view.rows.filter(r=>r.description!=='valid')) expect(row).toMatchObject({categories:null,parent:null});
  const [{v:filtered}]=await sql<{v:{total:number;summary:{expense:string}}}>(
    'select public.finance_transaction_view($1,$2,1,500) as v',[accountId,{...filters,categoryId}]);
  expect(filtered.total).toBe(1);expect(filtered.summary.expense).toBe('10.01');
  const [{v:snapshot}]=await sql<{v:{id:string;count:number}}>('select public.start_finance_export($1,$2) as v',[ownerId,filters]);
  expect(snapshot.count).toBe(view.total);
  const [{v:page}]=await sql<{v:{rows:{description:string;category:string;subcategory:string}[]}}>('select public.read_finance_export($1,$2,0,500) as v',[ownerId,snapshot.id]);
  for(const row of page.rows.filter(r=>r.description!=='valid')) expect(row).toMatchObject({category:'',subcategory:''});
  expect(JSON.stringify({summary,view,page})).not.toContain('Private foreign label');
});
