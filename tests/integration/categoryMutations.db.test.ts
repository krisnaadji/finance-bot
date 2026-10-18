import { beforeAll, afterAll, expect, it } from 'vitest';
import { applyPhase3MigrationsThrough, closeFixture, sql, sqlAs } from './helpers/phase2Db';
import { seedCategoryFixture, prepareCategoryCommand, commitCategoryCommand, addCategoryTransaction } from './categoryFixture';
beforeAll(() => applyPhase3MigrationsThrough());
afterAll(closeFixture);
it('freezes translated parent paths once and replays without recategorizing or rewriting text', async () => {
  const f=await seedCategoryFixture();
  await sql("update public.members set language_pref='en' where account_id=$1 and user_id=$2",[f.accountId,f.ownerId]);
  const command={kind:'create',accountId:f.accountId,recordedByName:'Owner',rows:[{categoryId:f.childId,amount:'0.01',type:'expense',description:'dinner',date:'2026-10-15'}]};
  const c=await prepareCategoryCommand(f,command), result=await commitCategoryCommand(c);
  const [reply]=await sql<{reply_payload:{rows:{categoryName:string}[]}}>('select reply_payload from public.bot_outbound where id=$1',[result.outboundIds[0]]);
  expect(reply.reply_payload.rows[0].categoryName).toBe('Food / Dining Out');
  await sql("update public.categories set name_en='Updated' where id=$1",[f.parentId]);
  expect((await commitCategoryCommand(c)).transactionIds).toEqual(result.transactionIds);
  expect((await sql<{reply_payload:unknown}>('select reply_payload from public.bot_outbound where id=$1',[result.outboundIds[0]]))[0].reply_payload).toEqual(reply.reply_payload);
});
it('allows untranslated custom child commands only for the linked account owner', async () => {
  const f=await seedCategoryFixture();
  const cmd={kind:'add_category',accountId:f.accountId,type:'expense',nameId:null,nameEn:'Custom Child',parentId:f.parentId};
  expect((await commitCategoryCommand(await prepareCategoryCommand(f,cmd))).code).toBe('category_added');
  const [row]=await sql<{parent_id:string;name_id:null;name_en:string}>('select parent_id,name_id,name_en from public.categories where account_id=$1 and name_en=$2',[f.accountId,'Custom Child']);
  expect(row).toEqual({parent_id:f.parentId,name_id:null,name_en:'Custom Child'});
  const member={...f,requester:'member'};
  expect((await commitCategoryCommand(await prepareCategoryCommand(member,{...cmd,nameEn:'Forbidden'}))).code).toBe('forbidden');
});
it('retains inactive IDs on description-only edits but rejects a fresh inactive selection', async () => {
  const f=await seedCategoryFixture();
  const id=await addCategoryTransaction(f.accountId,f.childId,'20.00');
  await sql('update public.categories set is_active=false where id=$1',[f.parentId]);
  const before={categoryId:f.childId,amount:'20.00',type:'expense',description:'fixture',date:'2026-10-15'};
  expect((await commitCategoryCommand(await prepareCategoryCommand(f,{kind:'edit',accountId:f.accountId,transactionId:id,before,editedByName:'Owner',patch:{description:'corrected'}}))).code).toBe('edited');
  await expect(addCategoryTransaction(f.accountId,f.childId,'1.00')).rejects.toMatchObject({code:'23514'});
});
it('atomically enforces owner-only translation reservations and resets only after the window', async () => {
  const f=await seedCategoryFixture();
  const reserve=(user=f.ownerId)=>sql<{ok:boolean}>('select public.reserve_category_translation($1,$2) as ok',[user,f.accountId]);
  expect((await reserve(f.memberId))[0].ok).toBe(false);
  const results=await Promise.all(Array.from({length:15},()=>reserve()));
  expect(results.filter(r=>r[0].ok)).toHaveLength(10);
  await sql("update public.category_translation_quotas set window_start=clock_timestamp()-interval '61 seconds' where account_id=$1",[f.accountId]);
  expect((await reserve())[0].ok).toBe(true);
  await expect(sqlAs('authenticated','select public.reserve_category_translation($1,$2)',[f.ownerId,f.accountId])).rejects.toMatchObject({code:'42501'});
  await sql('update public.accounts set is_active=false where id=$1',[f.accountId]);
  expect((await reserve())[0].ok).toBe(false);
});
it('rechecks durable child creation and optimistic corrections without partial writes',async()=>{
  const f=await seedCategoryFixture();
  const command={kind:'add_category',accountId:f.accountId,type:'expense',nameId:'Tidak Sah',nameEn:null,parentId:f.foreignCategoryId};
  for(const parentId of [f.foreignCategoryId,f.salaryId,f.childId]){
    expect((await commitCategoryCommand(await prepareCategoryCommand(f,{...command,parentId}))).code).toBe('invalid');
  }
  expect(await sql('select id from public.categories where account_id=$1 and name_id=$2',[f.accountId,command.nameId])).toEqual([]);
  const id=await addCategoryTransaction(f.accountId,f.childId,'10.00');
  const before={categoryId:f.childId,amount:'10.00',type:'expense',description:'fixture',date:'2026-10-15'};
  const claim=await prepareCategoryCommand(f,{kind:'edit',accountId:f.accountId,transactionId:id,before,editedByName:'Owner',patch:{description:'stale'}});
  await sql("update public.transactions set description='concurrent correction' where id=$1",[id]);
  expect((await commitCategoryCommand(claim)).code).toBe('conflict');
  expect((await sql<{description:string}>('select description from public.transactions where id=$1',[id]))[0].description).toBe('concurrent correction');
});
it('freezes Indonesian add-category paths and deletion labels without later live label reads',async()=>{
  const f=await seedCategoryFixture();
  const added=await commitCategoryCommand(await prepareCategoryCommand(f,{kind:'add_category',accountId:f.accountId,type:'expense',
    nameId:'Anak Baru',nameEn:'New Child',parentId:f.parentId}));
  expect((await sql<{reply_payload:{categoryName:string}}>('select reply_payload from public.bot_outbound where id=$1',[added.outboundIds[0]]))[0].reply_payload.categoryName).toBe('Makanan / Anak Baru');
  const id=await addCategoryTransaction(f.accountId,f.childId,'10.00');
  const prompt=await commitCategoryCommand(await prepareCategoryCommand(f,{kind:'delete_prompt',accountId:f.accountId,transactionId:id}));
  const [before]=await sql<{reply_payload:{rows:{categoryId:string;categoryName:string}[]}}>('select reply_payload from public.bot_outbound where id=$1',[prompt.outboundIds[0]]);
  expect(before.reply_payload.rows[0]).toMatchObject({categoryId:f.childId,categoryName:'Makanan / Makan di Luar'});
  await sql("update public.categories set name_id='Nama Baru' where id=$1",[f.parentId]);
  expect((await sql('select reply_payload from public.bot_outbound where id=$1',[prompt.outboundIds[0]]))[0]).toEqual(before);
});
