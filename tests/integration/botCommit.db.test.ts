import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { applyPhase2Migrations, closeFixture, seedLinkedFixture, sql } from './helpers/phase2Db';
import type { Fixture } from './helpers/phase2Db';

type Claim = { id: string; fence: string };
type Outcome = { outcome: string; code: string; batchId: string | null; transactionIds: string[]; outboundIds: string[] };
beforeAll(applyPhase2Migrations);
afterAll(closeFixture);
async function prepared(f: Fixture, command: unknown): Promise<Claim> {
  const d = { gateway:'meta',messageId:randomUUID(),chatId:f.chatId,rawFrom:f.requester,text:'fixture command',
    repliedToId:null,receivedAt:new Date().toISOString(),providerAt:null,fingerprint:'a'.repeat(64) };
  const [{ value }] = await sql<{value:{ids:string[]}}>('select public.ingest_bot_messages($1::jsonb) as value',[JSON.stringify([d])]);
  const [{ claim }] = await sql<{claim:Claim}>('select public.claim_bot_message($1) as claim',[value.ids[0]]);
  await sql('select public.save_bot_command($1,$2,$3::jsonb)',[claim.id,claim.fence,JSON.stringify(command)]);
  return claim;
}
function create(f: Fixture, amounts = ['10.00','20.00','30.00']) {
  return { kind:'create',accountId:f.accountId,recordedByName:'Fixture owner',rows:amounts.map((amount,index)=>({
    categoryId:f.categoryId,amount,type:'expense',description:`item ${index+1}`,date:'2026-10-13',
  })) };
}
async function commit(c: Claim): Promise<Outcome> {
  return (await sql<{value:Outcome}>('select public.commit_bot_command($1,$2) as value',[c.id,c.fence]))[0].value;
}
it('concurrent same-inbox commits create exactly one batch and logical receipt', async () => {
  const f=await seedLinkedFixture(),c=await prepared(f,create(f));
  const results=await Promise.all([commit(c),commit(c)]);
  expect(results.map(x=>x.outcome).sort()).toEqual(['committed','replayed']);
  expect(results[0].transactionIds).toEqual(results[1].transactionIds);
  const [counts]=await sql<{rows:string;replies:string}>('select (select count(*)::text from public.transactions where account_id=$1) as rows,(select count(*)::text from public.bot_outbound where inbox_id=$2) as replies',[f.accountId,c.id]);
  expect(counts).toEqual({rows:'3',replies:'1'});
});
it('one invalid item rejects the full financial batch', async () => {
  const f=await seedLinkedFixture(),c=await prepared(f,create(f,['10.00','0.001']));
  expect((await commit(c)).outcome).toBe('rejected');
  const [row]=await sql<{n:string}>('select count(*)::text as n from public.transactions where account_id=$1',[f.accountId]);
  expect(row.n).toBe('0');
});
it('deleting item two preserves item three and immutable receipt values', async () => {
  const f=await seedLinkedFixture(),c=await prepared(f,create(f));
  const result=await commit(c);
  await sql('delete from public.transactions where id=$1',[result.transactionIds[1]]);
  await sql("update public.transactions set amount=99,description='edited' where id=$1",[result.transactionIds[2]]);
  const mapping=await sql<{index:number;transactionId:string|null}>('select item_index as index,transaction_id as "transactionId" from public.bot_batch_items where batch_id=$1 order by item_index',[result.batchId]);
  expect(mapping).toEqual([{index:1,transactionId:result.transactionIds[0]},{index:2,transactionId:null},{index:3,transactionId:result.transactionIds[2]}]);
  const [reply]=await sql<{reply_payload:{rows:Array<{amount:string;description:string}>}}>('select reply_payload from public.bot_outbound where id=$1',[result.outboundIds[0]]);
  expect(reply.reply_payload.rows[2]).toMatchObject({amount:'30.00',description:'item 3'});
  expect((await commit(c)).transactionIds).toEqual(result.transactionIds);
});
it.each(['relink','deactivate'])('rejects a command after account %s', async change => {
  const f=await seedLinkedFixture(),c=await prepared(f,create(f));
  await sql(change==='relink'?'update public.accounts set wa_chat_id=$2 where id=$1':'update public.accounts set is_active=false where id=$1',change==='relink'?[f.accountId,randomUUID()]:[f.accountId]);
  expect((await commit(c)).code).toBe('inactive');
  const [row]=await sql<{n:string}>('select count(*)::text as n from public.transactions where account_id=$1',[f.accountId]);
  expect(row.n).toBe('0');
});
it('setup membership failure rolls back linkage and code consumption', async () => {
  const f=await seedLinkedFixture(),code=randomUUID().toUpperCase();
  await sql('update public.accounts set wa_chat_id=null where id=$1',[f.accountId]);
  await sql("insert into public.link_codes(account_id,code,expires_at) values($1,$2,clock_timestamp()+interval '15 minutes')",[f.accountId,code]);
  f.requester='setup-outsider';
  const c=await prepared(f,{kind:'setup',code,language:'id'});
  await sql(`create function public.fixture_reject_member() returns trigger language plpgsql as $$ begin raise exception 'fixture member rejection'; end $$;
    create trigger fixture_reject_member before insert on public.members for each row execute function public.fixture_reject_member()`);
  try { await expect(commit(c)).rejects.toThrow('fixture member rejection'); }
  finally { await sql('drop trigger fixture_reject_member on public.members;drop function public.fixture_reject_member()'); }
  const [account]=await sql<{wa_chat_id:string|null}>('select wa_chat_id from public.accounts where id=$1',[f.accountId]);
  const [link]=await sql<{used:boolean}>('select used from public.link_codes where code=$1',[code]);
  expect(account.wa_chat_id).toBeNull();expect(link.used).toBe(false);
  expect((await commit(c)).code).toBe('setup_ok');
});

it('replaying an old plain confirmation never consumes a replacement pending action', async () => {
  const f=await seedLinkedFixture();
  const result=await commit(await prepared(f,create(f,['10.00'])));
  const prompt={kind:'delete_prompt',accountId:f.accountId,transactionId:result.transactionIds[0]};
  await commit(await prepared(f,prompt));
  const [old]=await sql<{id:string}>('select id from public.pending_actions where account_id=$1',[f.accountId]);
  await sql("update public.pending_actions set confirmation_message_id='fixture-confirmation' where id=$1",[old.id]);
  const decision=await prepared(f,{kind:'delete_decision',accountId:f.accountId,pendingId:old.id,confirmationMessageId:'fixture-confirmation',decision:'cancel'});
  expect((await commit(decision)).code).toBe('cancelled');
  await commit(await prepared(f,prompt));
  const [replacement]=await sql<{id:string}>('select id from public.pending_actions where account_id=$1',[f.accountId]);
  expect((await commit(decision)).code).toBe('cancelled');
  const pending=await sql<{id:string}>('select id from public.pending_actions where account_id=$1',[f.accountId]);
  expect(pending).toEqual([{id:replacement.id}]);
});

it('missing account rejection is durable rather than a broken outbound foreign key', async () => {
  const f=await seedLinkedFixture();
  const command=create(f,['10.00']);
  command.accountId=randomUUID();
  expect((await commit(await prepared(f,command))).code).toBe('inactive');
});

it('a surviving legacy row cannot establish its original batch ordinal', async () => {
  const f=await seedLinkedFixture();
  const ids=[randomUUID(),randomUUID()];
  await sql(`insert into public.transactions(id,account_id,amount,type,date,description,wa_user_message_id,wa_bot_message_id)
    values($1,$3,10,'expense','2026-10-13','first','legacy-input','legacy-receipt'),
          ($2,$3,20,'expense','2026-10-13','second','legacy-input','legacy-receipt')`,[ids[0],ids[1],f.accountId]);
  await sql('delete from public.transactions where id=$1',[ids[0]]);
  const [lookup]=await sql<{value:unknown}>("select public.lookup_bot_receipt($1,'meta','legacy-receipt') as value",[f.accountId]);
  expect(lookup.value).toEqual([]);
});

it('setup helper is outside the exposed public RPC schema', async () => {
  const [helper]=await sql<{exposed:string|null}>("select to_regprocedure('public.apply_bot_setup(text,text,text,text)')::text as exposed");
  expect(helper.exposed).toBeNull();
});
it('a failure during the second insert rolls back financial rows, mapping, and reply together', async()=>{
  const f=await seedLinkedFixture(), c=await prepared(f,create(f));
  await sql(`create function public.fixture_reject_second() returns trigger language plpgsql as $$ begin
    if new.description='item 2' then raise exception 'fixture insert failure'; end if; return new; end $$;
    create trigger fixture_reject_second before insert on public.transactions for each row execute function public.fixture_reject_second()`);
  try { await expect(commit(c)).rejects.toThrow('fixture insert failure'); }
  finally { await sql('drop trigger fixture_reject_second on public.transactions;drop function public.fixture_reject_second()'); }
  const [counts]=await sql<{transactions:string;batches:string;replies:string}>(`select
    (select count(*)::text from public.transactions where account_id=$1) as transactions,
    (select count(*)::text from public.bot_batches where inbox_id=$2) as batches,
    (select count(*)::text from public.bot_outbound where inbox_id=$2) as replies`,[f.accountId,c.id]);
  expect(counts).toEqual({transactions:'0',batches:'0',replies:'0'});
  expect((await commit(c)).transactionIds).toHaveLength(3);
});
it('foreign categories and expired claim fences cannot create financial rows', async()=>{
  const f=await seedLinkedFixture(),foreign=await seedLinkedFixture(),command=create(f,['10.00']);
  command.rows[0].categoryId=foreign.categoryId;
  expect((await commit(await prepared(f,command))).code).toBe('invalid');
  const c=await prepared(f,create(f,['10.00']));
  await sql("update public.bot_inbox set lease_until=clock_timestamp()-interval '1 second' where id=$1",[c.id]);
  await expect(commit(c)).rejects.toThrow('Inbox claim lost');
  expect(await sql('select id from public.transactions where account_id=$1',[f.accountId])).toEqual([]);
});
it('an optimistic edit cannot overwrite a newer dashboard edit', async()=>{
  const f=await seedLinkedFixture(),before=create(f,['10.00']).rows[0];
  const original=await commit(await prepared(f,create(f,['10.00'])));
  const c=await prepared(f,{kind:'edit',accountId:f.accountId,transactionId:original.transactionIds[0],
    before,editedByName:'Fixture member',patch:{description:'bot edit'}});
  await sql("update public.transactions set description='dashboard edit' where id=$1",[original.transactionIds[0]]);
  expect((await commit(c)).code).toBe('conflict');
  const [row]=await sql<{description:string}>('select description from public.transactions where id=$1',[original.transactionIds[0]]);
  expect(row.description).toBe('dashboard edit');
});
it('description edits retain inactive historical categories, attribution, and new receipt targeting', async()=>{
  const f=await seedLinkedFixture(),before=create(f,['10.00']).rows[0];
  const original=await commit(await prepared(f,create(f,['10.00'])));
  await sql('update public.categories set is_active=false where id=$1',[f.categoryId]);
  const c=await prepared(f,{kind:'edit',accountId:f.accountId,transactionId:original.transactionIds[0],
    before,editedByName:'Fixture member',patch:{description:'corrected meal'}});
  const changed=await commit(c);
  expect(changed.code).toBe('edited');
  const [row]=await sql<{description:string;category_id:string;edited_by_name:string}>('select description,category_id,edited_by_name from public.transactions where id=$1',[original.transactionIds[0]]);
  expect(row).toEqual({description:'corrected meal',category_id:f.categoryId,edited_by_name:'Fixture member'});
  const [mapping]=await sql<{value:Array<{index:number;transactionId:string|null}>}>('select public.lookup_bot_receipt($1,$2,(select message_id from public.bot_inbox where id=$3)) as value',[f.accountId,'meta',c.id]);
  expect(mapping.value).toEqual([{index:1,transactionId:original.transactionIds[0]}]);
});
it('competing setup requesters consume one code and create only the winning membership', async()=>{
  const f=await seedLinkedFixture(),code=randomUUID().toUpperCase();
  await sql('update public.accounts set wa_chat_id=null where id=$1',[f.accountId]);
  await sql("insert into public.link_codes(account_id,code,expires_at) values($1,$2,clock_timestamp()+interval '15 minutes')",[f.accountId,code]);
  const first={...f,chatId:randomUUID(),requester:'fixture-first'},second={...f,chatId:randomUUID(),requester:'fixture-second'};
  const claims=await Promise.all([prepared(first,{kind:'setup',code,language:'id'}),prepared(second,{kind:'setup',code,language:'en'})]);
  const results=await Promise.all(claims.map(commit));
  expect(results.map(result=>result.code).sort()).toEqual(['setup_bad_code','setup_ok']);
  const winner=results[0].code === 'setup_ok' ? first : second;
  const [account]=await sql<{wa_chat_id:string}>('select wa_chat_id from public.accounts where id=$1',[f.accountId]);
  expect(account.wa_chat_id).toBe(winner.chatId);
  const members=await sql<{wa_phone:string}>('select wa_phone from public.members where account_id=$1 and wa_phone in ($2,$3)',[f.accountId,first.requester,second.requester]);
  expect(members).toEqual([{wa_phone:winner.requester}]);
});
it('verified historical single receipt IDs remain addressable without inferring survivor indices', async()=>{
  const f=await seedLinkedFixture(),id=randomUUID(),message=randomUUID();
  await sql("insert into public.transactions(id,account_id,amount,type,description,date,wa_bot_message_id) values($1,$2,10,'expense','verified original single','2026-10-13',$3)",[id,f.accountId,message]);
  await sql('insert into public.bot_legacy_receipt_items(gateway,message_id,account_id,item_index,transaction_id) values($1,$2,$3,1,$4)',['meta',message,f.accountId,id]);
  const lookup=()=>sql<{value:Array<{index:number;transactionId:string|null}>}>('select public.lookup_bot_receipt($1,$2,$3) as value',[f.accountId,'meta',message]);
  expect((await lookup())[0].value).toEqual([{index:1,transactionId:id}]);
  await sql('delete from public.transactions where id=$1',[id]);
  expect((await lookup())[0].value).toEqual([{index:1,transactionId:null}]);
});
it('language changes preserve membership identity, linked user, role, and display name without phone uniqueness', async()=>{
  const f=await seedLinkedFixture();
  const [before]=await sql<{id:string;user_id:string;role:string;display_name:string}>('select id,user_id,role,display_name from public.members where account_id=$1 and wa_phone=$2',[f.accountId,f.requester]);
  expect((await commit(await prepared(f,{kind:'set_language',accountId:f.accountId,language:'en'}))).code).toBe('language_changed');
  const [after]=await sql<{id:string;user_id:string;role:string;display_name:string;language_pref:string}>('select id,user_id,role,display_name,language_pref from public.members where account_id=$1 and wa_phone=$2',[f.accountId,f.requester]);
  expect(after).toEqual({...before,language_pref:'en'});
});
