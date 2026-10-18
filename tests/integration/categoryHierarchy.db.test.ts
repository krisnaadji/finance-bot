import { beforeAll, afterAll, expect, it } from 'vitest';
import { applyPhase3MigrationsThrough, closeFixture, sql } from './helpers/phase2Db';
import { seedCategoryFixture, addCategoryTransaction } from './categoryFixture';
beforeAll(() => applyPhase3MigrationsThrough());
afterAll(closeFixture);
it('retains historical references, custom labels, inactive paths and exact budgets', async () => {
  const f = await seedCategoryFixture();
  const id = await addCategoryTransaction(f.accountId,f.childId,'123.45');
  await sql('insert into public.budgets(account_id,category_id,amount) values($1,$2,3000000)',[f.accountId,f.parentId]);
  await sql('update public.categories set is_active=false where id=$1',[f.parentId]);
  const [row] = await sql<{category_id:string;amount:string;name_id:string;parent_id:string}>(`select t.category_id,t.amount,c.name_id,c.parent_id from public.transactions t join public.categories c on c.id=t.category_id where t.id=$1`,[id]);
  expect(row).toEqual({category_id:f.childId,amount:'123.45',name_id:'Makan di Luar',parent_id:f.parentId});
  expect((await sql<{amount:string}>('select amount from public.budgets where account_id=$1',[f.accountId]))[0].amount).toBe('3000000.00');
});
it('rejects cross-account, cross-type, self, third-level, salary and reparent selections at SQL boundary', async () => {
  const f=await seedCategoryFixture();
  for (const [account,parent,type] of [[f.foreignAccountId,f.parentId,'expense'],[f.accountId,f.parentId,'income'],[f.accountId,f.childId,'expense'],[f.accountId,f.salaryId,'income']]) {
    await expect(sql(`insert into public.categories(account_id,parent_id,name_id,type,is_custom) values($1,$2,'Invalid',$3,true)`,[account,parent,type])).rejects.toMatchObject({code:'23514'});
  }
  await expect(sql('update public.categories set parent_id=id where id=$1',[f.parentId])).rejects.toMatchObject({code:'23514'});
  await expect(sql('update public.categories set parent_id=$2 where id=$1',[f.childId,f.legacyId])).rejects.toMatchObject({code:'23514'});
  expect((await sql<{parent_id:string}>('select parent_id from public.categories where id=$1',[f.childId]))[0].parent_id).toBe(f.parentId);
});
it('serializes sibling duplicate checks while allowing repeated labels in different roots and types', async () => {
  const f=await seedCategoryFixture();
  const results=await Promise.allSettled([1,2].map(()=>sql(`insert into public.categories(account_id,parent_id,name_id,type,is_custom) values($1,$2,'Concurrent','expense',true)`,[f.accountId,f.parentId])));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'23505'});
  await sql(`insert into public.categories(account_id,parent_id,name_id,type,is_custom) values($1,$2,'Concurrent','expense',true),($1,null,'Concurrent','income',true)`,[f.accountId,f.legacyId]);
});
it('serializes parent deactivation against new selection and forbids child budgets', async () => {
  const f=await seedCategoryFixture();
  await expect(sql('insert into public.budgets(account_id,category_id,amount) values($1,$2,1)',[f.accountId,f.childId])).rejects.toMatchObject({code:'23514'});
  await sql('update public.categories set is_active=false where id=$1',[f.parentId]);
  const row={categoryId:f.childId,type:'expense',amount:'0.01',description:'test',date:'2026-10-15'};
  expect((await sql<{v:boolean}>('select public.valid_bot_transaction($1,$2) as v',[row,f.accountId]))[0].v).toBe(false);
  expect((await sql<{v:boolean}>('select public.valid_bot_transaction($1,$2,true) as v',[row,f.accountId]))[0].v).toBe(true);
});
it('serializes a parent eligibility change with concurrent transaction and budget selection without deadlocks', async () => {
  const f=await seedCategoryFixture();
  const results=await Promise.allSettled([
    sql('update public.categories set is_active=false where id=$1',[f.parentId]),
    addCategoryTransaction(f.accountId,f.childId,'0.01'),
    sql('insert into public.budgets(account_id,category_id,amount) values($1,$2,20)',[f.accountId,f.parentId]),
  ]);
  expect(results[0].status).toBe('fulfilled');
  for (const result of results.slice(1)) {
    if (result.status==='rejected') expect(result.reason).toMatchObject({code:'23514'});
  }
  await expect(addCategoryTransaction(f.accountId,f.childId,'0.01')).rejects.toMatchObject({code:'23514'});
  await expect(sql('insert into public.budgets(account_id,category_id,amount) values($1,$2,30)',[f.accountId,f.parentId])).rejects.toMatchObject({code:'23514'});
});
it('rejects reactivation under an inactive parent while preserving historical child labels', async () => {
  const f=await seedCategoryFixture();
  await sql('update public.categories set is_active=false where id in ($1,$2)',[f.parentId,f.childId]);
  await expect(sql('update public.categories set is_active=true where id=$1',[f.childId])).rejects.toMatchObject({code:'23514'});
  await sql("update public.categories set name_en='Historical child' where id=$1",[f.childId]);
  expect((await sql<{name_en:string}>('select name_en from public.categories where id=$1',[f.childId]))[0].name_en).toBe('Historical child');
});
it('keeps identity immutable and requires at least one real bilingual label',async()=>{
  const f=await seedCategoryFixture();
  for(const [column,value] of [['account_id',f.foreignAccountId],['type','income'],['code','expense.forged'],['is_custom',false]]){
    await expect(sql(`update public.categories set ${column}=$2 where id=$1`,[f.parentId,value])).rejects.toMatchObject({code:'23514'});
  }
  await expect(sql(`insert into public.categories(account_id,name_id,name_en,type,is_custom)
    values($1,'  ',null,'expense',true)`,[f.accountId])).rejects.toMatchObject({code:'23514'});
  await expect(sql('update public.categories set name_id=null,name_en=null where id=$1',[f.childId])).rejects.toMatchObject({code:'23514'});
  expect((await sql<{parent_id:string}>('select parent_id from public.categories where id=$1',[f.childId]))[0].parent_id).toBe(f.parentId);
});
