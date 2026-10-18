import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { applyPhase2Migrations, applyPhase3MigrationsThrough, closeFixture, sql } from './helpers/phase2Db';
let accountId:string,legacyId:string,salaryId:string,transactionId:string,budgetId:string;
beforeAll(async()=>{
 await applyPhase2Migrations();
 const owner=randomUUID();accountId=randomUUID();legacyId=randomUUID();salaryId=randomUUID();transactionId=randomUUID();budgetId=randomUUID();
 await sql('insert into auth.users(id) values($1)',[owner]);
 await sql("insert into public.accounts(id,name,owner_id) values($1,'Legacy',$2)",[accountId,owner]);
 await sql("insert into public.categories(id,account_id,name,type) values($1,$3,'Kebutuhan Pokok','expense'),($2,$3,'Gaji','income')",[legacyId,salaryId,accountId]);
 await sql("insert into public.transactions(id,account_id,category_id,amount,type,date) values($1,$2,$3,123.45,'expense','2026-10-15')",[transactionId,accountId,legacyId]);
 await sql('insert into public.budgets(id,account_id,category_id,amount) values($1,$2,$3,987.65)',[budgetId,accountId,legacyId]);
 await applyPhase3MigrationsThrough();
});
afterAll(closeFixture);
it('maps only verified default tuples without moving legacy references or budgets into new roots',async()=>{
 const [legacy]=await sql<{id:string;code:string}>('select id,code from public.categories where id=$1',[legacyId]);
 expect(legacy).toEqual({id:legacyId,code:'expense.basic_needs'});
 expect((await sql<{category_id:string;amount:string}>('select category_id,amount from public.transactions where id=$1',[transactionId]))[0]).toEqual({category_id:legacyId,amount:'123.45'});
 expect((await sql<{category_id:string;amount:string}>('select category_id,amount from public.budgets where id=$1',[budgetId]))[0]).toEqual({category_id:legacyId,amount:'987.65'});
 expect((await sql<{id:string}>('select id from public.categories where account_id=$1 and code=$2',[accountId,'salary']))[0].id).toBe(salaryId);
 const roots=await sql<{id:string;parent_id:null}>('select id,parent_id from public.categories where account_id=$1 and code in ($2,$3)',[accountId,'expense.food','expense.household']);
 expect(roots).toHaveLength(2);expect(roots.every(r=>r.parent_id===null&&r.id!==legacyId)).toBe(true);
});
it('repeated seeding preserves inactive defaults, edited labels and catalog child identity',async()=>{
 const [food]=await sql<{id:string}>('select id from public.categories where account_id=$1 and code=$2',[accountId,'expense.food']);
 await sql("update public.categories set name_en='Edited Food',is_active=false where id=$1",[food.id]);
 const before=await sql('select id,code,parent_id,name_id,name_en,is_active from public.categories where account_id=$1 order by id',[accountId]);
 await sql('select public.seed_categories($1)',[accountId]);await sql('select public.seed_categories($1)',[accountId]);
 expect(await sql('select id,code,parent_id,name_id,name_en,is_active from public.categories where account_id=$1 order by id',[accountId])).toEqual(before);
 const [child]=await sql<{parent_id:string}>('select parent_id from public.categories where account_id=$1 and code=$2',[accountId,'expense.food.dining_out']);
 expect(child.parent_id).toBe(food.id);
});
it('new atomic accounts receive the same identities and idempotent owner membership',async()=>{
 const user=randomUUID(),operation=randomUUID();await sql('insert into auth.users(id) values($1)',[user]);
 const args=[user,operation,'New catalog','personal','Owner'];
 const [{v:created}]=await sql<{v:{code:string;account:{id:string}}}>('select public.create_finance_account($1,$2,$3,$4,$5) as v',args);
 const [{v:replayed}]=await sql<{v:{code:string;account:{id:string}}}>('select public.create_finance_account($1,$2,$3,$4,$5) as v',args);
 expect(created.code).toBe('accepted');expect(replayed.account.id).toBe(created.account.id);
 const id=created.account.id;
 expect(await sql('select id from public.members where account_id=$1 and user_id=$2 and role=$3',[id,user,'owner'])).toHaveLength(1);
 const salary=await sql('select id from public.categories where account_id=$1 and code=$2 and parent_id is null and type=$3',[id,'salary','income']);
 expect(salary).toHaveLength(1);
 const violations=await sql(`select c.id from public.categories c join public.categories p on p.id=c.parent_id where c.account_id=$1 and (p.account_id<>c.account_id or p.type<>c.type or p.parent_id is not null)`,[id]);
 expect(violations).toEqual([]);
});
