import { randomUUID } from 'node:crypto';
import { sql } from './helpers/phase2Db';

export interface CategoryFixture {
  accountId:string; ownerId:string; memberId:string;
  parentId:string; childId:string; otherChildId:string; salaryId:string;
  bonusId:string; legacyId:string; foreignAccountId:string; foreignCategoryId:string;
  chatId:string; requester:string;
}

export async function seedCategoryFixture(): Promise<CategoryFixture> {
  const f = { accountId: randomUUID(), ownerId: randomUUID(), memberId: randomUUID(),
    parentId: randomUUID(), childId: randomUUID(), otherChildId: randomUUID(), salaryId: randomUUID(),
    bonusId: randomUUID(), legacyId: randomUUID(), foreignAccountId: randomUUID(), foreignCategoryId: randomUUID(),
    chatId: `category-chat-${randomUUID()}`, requester: `category-owner-${randomUUID()}` };
  await sql('insert into auth.users(id) values($1),($2)', [f.ownerId, f.memberId]);
  await sql(`insert into public.accounts(id,name,owner_id,wa_chat_id) values($1,'Categories',$2,$3),($4,'Foreign',$2,null)`,
    [f.accountId, f.ownerId, f.chatId, f.foreignAccountId]);
  await sql(`insert into public.members(account_id,user_id,wa_phone,role) values($1,$2,$3,'owner'),($1,$4,'member','member')`,
    [f.accountId, f.ownerId, f.requester, f.memberId]);
  await sql(`insert into public.categories(id,account_id,code,name_id,name_en,type,is_custom) values
    ($1,$7,null,'Makanan','Food','expense',true),($2,$7,'salary','Gaji','Salary','income',false),
    ($3,$7,null,'Bonus','Bonus','income',true),($4,$7,null,'Kebutuhan Pokok','Basic Needs','expense',true),
    ($5,$6,null,'Asing','Foreign','expense',true)`,
    [f.parentId,f.salaryId,f.bonusId,f.legacyId,f.foreignCategoryId,f.foreignAccountId,f.accountId]);
  await sql(`insert into public.categories(id,account_id,parent_id,name_id,name_en,type,is_custom) values
    ($1,$3,$4,'Makan di Luar','Dining Out','expense',true),($2,$3,$4,'Bahan Makanan','Groceries','expense',true)`,
    [f.childId,f.otherChildId,f.accountId,f.parentId]);
  await sql(`insert into public.categories(account_id,code,name_id,name_en,type) values
    ($1,'expense.other','Pengeluaran Lainnya','Other Expenses','expense'),
    ($1,'income.other','Pemasukan Lainnya','Other Income','income')`,[f.accountId]);
  return f;
}

export async function addCategoryTransaction(accountId: string, categoryId: string | null, amount: string, type = 'expense', description = 'fixture') {
  return (await sql<{id:string}>(`insert into public.transactions(account_id,category_id,amount,type,date,description)
    values($1,$2,$3,$4,'2026-10-15',$5) returning id`,[accountId,categoryId,amount,type,description]))[0].id;
}

export async function prepareCategoryCommand(f: {accountId:string;chatId:string;requester:string}, command: unknown) {
  const message = {gateway:'meta',messageId:randomUUID(),chatId:f.chatId,rawFrom:f.requester,text:'local category fixture',
    repliedToId:null,receivedAt:new Date().toISOString(),providerAt:null,fingerprint:'a'.repeat(64)};
  const [{value}] = await sql<{value:{ids:string[]}}>('select public.ingest_bot_messages($1::jsonb) as value',[JSON.stringify([message])]);
  const [{claim}] = await sql<{claim:{id:string;fence:string}}>('select public.claim_bot_message($1) as claim',[value.ids[0]]);
  await sql('select public.save_bot_command($1,$2,$3::jsonb)',[claim.id,claim.fence,JSON.stringify(command)]);
  return claim;
}
export async function commitCategoryCommand(claim: {id:string;fence:string}) {
  return (await sql<{value:{code:string;outcome:string;transactionIds:string[];outboundIds:string[];batchId:string}}>(
    'select public.commit_bot_command($1,$2) as value',[claim.id,claim.fence]))[0].value;
}
