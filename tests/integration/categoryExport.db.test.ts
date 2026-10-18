import { beforeAll, afterAll, expect, it } from 'vitest';
import { applyPhase3MigrationsThrough, closeFixture, sql } from './helpers/phase2Db';
import { seedCategoryFixture, addCategoryTransaction } from './categoryFixture';
beforeAll(() => applyPhase3MigrationsThrough());
afterAll(closeFixture);
it('freezes requested root/child language with fallback and keeps immutable ordinal pages after live edits', async () => {
 const f=await seedCategoryFixture();
 await sql("update public.categories set name_en=null where id=$1",[f.childId]);
 await addCategoryTransaction(f.accountId,f.childId,'1.01');
 await addCategoryTransaction(f.accountId,f.parentId,'2.02');
 const filters={accountId:f.accountId,categoryId:f.parentId,locale:'en'};
 const [{snapshot}]=await sql<{snapshot:{id:string;count:number}}>('select public.start_finance_export($1,$2) as snapshot',[f.memberId,filters]);
 expect(snapshot.count).toBe(2);
 const read=()=>sql<{page:{rows:{ordinal:number;category:string;subcategory:string;amount:string}[]}}>('select public.read_finance_export($1,$2,0,500) as page',[f.memberId,snapshot.id]);
 const [before]=await read();
 expect(before.page.rows).toEqual(expect.arrayContaining([expect.objectContaining({category:'Food',subcategory:'Makan di Luar',amount:'1.01'}),expect.objectContaining({category:'Food',subcategory:'',amount:'2.02'})]));
 expect(before.page.rows.map(r=>r.ordinal)).toEqual([1,2]);
 await sql("update public.categories set name_en='Renamed' where id=$1",[f.parentId]);
 await sql("update public.transactions set amount=99 where account_id=$1",[f.accountId]);
 expect((await read())[0]).toEqual(before);
});
it('uses identical hierarchy/search predicates for count, summary and export including 501-row paging', async()=>{
 const f=await seedCategoryFixture();
 await sql(`insert into public.transactions(account_id,category_id,amount,type,date,description)
 select $1,$2,0.01,'expense','2026-10-15','match' from generate_series(1,501)`,[f.accountId,f.childId]);
 const filters={accountId:f.accountId,categoryId:f.parentId,subcategoryId:f.childId,search:'mat%',locale:'id'};
 const [{v}]=await sql<{v:{total:number;summary:{expense:string}}}>('select public.finance_transaction_view($1,$2,1,500) as v',[f.accountId,filters]);
 const [{s}]=await sql<{s:{id:string;count:number}}>('select public.start_finance_export($1,$2) as s',[f.ownerId,filters]);
 expect(v.total).toBe(501);expect(v.summary.expense).toBe('5.01');expect(s.count).toBe(v.total);
 const [{p}]=await sql<{p:{rows:{ordinal:number}[]}}>('select public.read_finance_export($1,$2,500,500) as p',[f.ownerId,s.id]);
 expect(p.rows.map(r=>r.ordinal)).toEqual([501]);
 const [{denied}]=await sql<{denied:{code:string}}>('select public.read_finance_export($1,$2,0,500) as denied',[f.memberId,s.id]);
 expect(denied.code).toBe('not_found');
});
it('matches parent, child and direct exports to the same exact filtered rows and rechecks revocation and expiry',async()=>{
 const f=await seedCategoryFixture();
 await addCategoryTransaction(f.accountId,f.parentId,'1.01');
 await addCategoryTransaction(f.accountId,f.childId,'2.02');
 await addCategoryTransaction(f.accountId,f.otherChildId,'3.03');
 for(const hierarchy of [{categoryId:f.parentId},{categoryId:f.childId},{categoryId:f.parentId,categoryScope:'direct'},{categoryId:f.parentId,subcategoryId:f.childId}]){
  const filters={accountId:f.accountId,locale:'id',...hierarchy};
  const [{v}]=await sql<{v:{rows:{id:string}[];total:number}}>('select public.finance_transaction_view($1,$2,1,500) as v',[f.accountId,filters]);
  const [{s}]=await sql<{s:{id:string;count:number}}>('select public.start_finance_export($1,$2) as s',[f.memberId,filters]);
  const [{p}]=await sql<{p:{rows:{transactionId:string}[]}}>('select public.read_finance_export($1,$2,0,500) as p',[f.memberId,s.id]);
  expect(s.count).toBe(v.total);expect(p.rows.map(r=>r.transactionId)).toEqual(v.rows.map(r=>r.id));
 }
 const [{s}]=await sql<{s:{id:string}}>('select public.start_finance_export($1,$2) as s',[f.memberId,{accountId:f.accountId,locale:'en'}]);
 await sql('delete from public.members where account_id=$1 and user_id=$2',[f.accountId,f.memberId]);
 expect((await sql<{v:{code:string}}>('select public.read_finance_export($1,$2,0,500) as v',[f.memberId,s.id]))[0].v.code).toBe('forbidden');
 const [{owner}]=await sql<{owner:{id:string}}>('select public.start_finance_export($1,$2) as owner',[f.ownerId,{accountId:f.accountId,locale:'en'}]);
 await sql("update public.finance_export_snapshots set expires_at=clock_timestamp()-interval '1 second' where id=$1",[owner.id]);
 expect((await sql<{v:{code:string}}>('select public.read_finance_export($1,$2,0,500) as v',[f.ownerId,owner.id]))[0].v.code).toBe('expired');
});
it('rejects a UTF-8 snapshot exceeding the byte cap atomically with no partial frozen rows',async()=>{
 const f=await seedCategoryFixture();
 await sql(`insert into public.transactions(account_id,category_id,amount,type,date,description)
  select $1,$2,0.01,'expense','2026-10-15',repeat('界',350000) from generate_series(1,33)`,[f.accountId,f.childId]);
 const [{v}]=await sql<{v:{code:string}}>('select public.start_finance_export($1,$2) as v',[f.ownerId,{accountId:f.accountId,locale:'en'}]);
 expect(v.code).toBe('limit');
 expect(await sql('select id from public.finance_export_snapshots where account_id=$1',[f.accountId])).toEqual([]);
 expect(await sql(`select r.ordinal from public.finance_export_rows r join public.finance_export_snapshots s on s.id=r.snapshot_id where s.account_id=$1`,[f.accountId])).toEqual([]);
});
