import { beforeAll, afterAll, expect, it } from 'vitest';
import { applyPhase3MigrationsThrough, closeFixture, sql, sqlAs } from './helpers/phase2Db';
import { seedCategoryFixture, addCategoryTransaction } from './categoryFixture';
beforeAll(() => applyPhase3MigrationsThrough());
afterAll(closeFixture);
const range={from:'2026-10-01',to:'2026-10-31',locale:'en'};
async function view(accountId:string, filters:Record<string,unknown>={},page=1,size=500) {
  return (await sql<{v:{code?:string;total:number;rows:{id:string;categories:{id:string};parent:{id:string}}[];summary:{income:string;expense:string;net:string}}}>(
    'select public.finance_transaction_view($1,$2,$3,$4) as v',[accountId,{accountId,...range,...filters},page,size]))[0].v;
}
it('reconciles root rollups, direct detail, monthly income and parent budgets exactly once', async () => {
  const f=await seedCategoryFixture();
  for(const [id,amount,type] of [[f.parentId,'100.00','expense'],[f.childId,'200.00','expense'],[f.otherChildId,'300.00','expense'],[f.legacyId,'400.00','expense'],[f.salaryId,'1000.00','income'],[f.bonusId,'500.00','income']]) await addCategoryTransaction(f.accountId,id,amount,type);
  const [{v}]=await sql<{v:{income:string;expense:string;net:string;spendingByCategoryId:Record<string,string>;categoryDetails:{parentId:string;categoryId:string;amount:string}[]}}>('select public.finance_summary($1,$2,$3) as v',[f.accountId,range.from,range.to]);
  expect(v).toMatchObject({income:'1500.00',expense:'1000.00',net:'500.00',spendingByCategoryId:{[f.parentId]:'600.00',[f.legacyId]:'400.00'}});
  expect(v.categoryDetails).toEqual(expect.arrayContaining([{parentId:f.parentId,categoryId:f.parentId,amount:'100.00'},{parentId:f.parentId,categoryId:f.childId,amount:'200.00'}]));
  expect((await sql<{v:unknown}>('select public.finance_budget_spending($1,$2,$3) as v',[f.accountId,range.from,range.to]))[0].v).toEqual({spendingByCategoryId:v.spendingByCategoryId});
  expect((await view(f.accountId,{categoryId:f.parentId})).total).toBe(3);
  expect((await view(f.accountId,{categoryId:f.parentId,categoryScope:'direct'})).summary.expense).toBe('100.00');
  expect((await view(f.accountId,{categoryId:f.parentId,subcategoryId:f.childId})).summary.expense).toBe('200.00');
  expect((await view(f.accountId,{categoryId:f.childId})).total).toBe(1);
});
it('counts and sums complete >1500-row matches before stable pagination above safe integer cents', async () => {
  const f=await seedCategoryFixture();
  await sql(`insert into public.transactions(account_id,category_id,amount,type,date,description) select $1,$2,'9999999999999.99','expense','2026-10-15','bulk' from generate_series(1,1501)`,[f.accountId,f.childId]);
  const a=await view(f.accountId,{categoryId:f.parentId},1,500),b=await view(f.accountId,{categoryId:f.parentId},2,500);
  expect(a.total).toBe(1501);expect(a.summary.expense).toBe('15009999999999984.99');
  expect(a.rows).toHaveLength(500);expect(b.rows).toHaveLength(500);
  expect(new Set([...a.rows,...b.rows].map(r=>r.id)).size).toBe(1000);
  expect(a.rows[0]).toMatchObject({categories:{id:f.childId},parent:{id:f.parentId}});
});
it('rejects invalid root child/type/date/locale combinations and inaccessible RPCs', async () => {
  const f=await seedCategoryFixture();
  for(const filter of [{categoryId:f.foreignCategoryId},{categoryId:f.parentId,subcategoryId:f.childId,categoryScope:'direct'},
    {subcategoryId:f.childId},{categoryId:f.legacyId,subcategoryId:f.childId},{categoryId:f.parentId,type:'income'},
    {from:'2026-02-30'},{locale:'fr'},{categoryId:f.childId,subcategoryId:f.otherChildId}]) expect((await view(f.accountId,filter)).code).toBe('invalid');
  expect((await view(f.accountId,{},0)).code).toBe('invalid');
  await expect(sqlAs('anon','select public.finance_transaction_view($1,$2,1,500)',[f.accountId,{}])).rejects.toMatchObject({code:'42501'});
  await sql('update public.accounts set is_active=false where id=$1',[f.accountId]);
  expect((await view(f.accountId)).code).toBe('forbidden');
});
it('keeps identical child labels under different roots separate across reports and filters',async()=>{
  const f=await seedCategoryFixture();
  const [{id:other}]=await sql<{id:string}>(`insert into public.categories(account_id,parent_id,name_id,name_en,type,is_custom)
    select account_id,$2,name_id,name_en,type,true from public.categories where id=$1 returning id`,[f.childId,f.legacyId]);
  await addCategoryTransaction(f.accountId,f.childId,'0.01');
  await addCategoryTransaction(f.accountId,other,'0.02');
  const [{v}]=await sql<{v:{expense:string;spendingByCategoryId:Record<string,string>}}>('select public.finance_summary($1,$2,$3) as v',[f.accountId,range.from,range.to]);
  expect(v.expense).toBe('0.03');
  expect(v.spendingByCategoryId).toEqual({[f.parentId]:'0.01',[f.legacyId]:'0.02'});
  expect((await view(f.accountId,{categoryId:f.parentId})).summary.expense).toBe('0.01');
  expect((await view(f.accountId,{categoryId:f.legacyId})).summary.expense).toBe('0.02');
});
