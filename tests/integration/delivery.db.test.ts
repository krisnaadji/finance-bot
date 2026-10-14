import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { applyPhase2MigrationsThrough,closeFixture,seedLinkedFixture,sql,sqlAs } from './helpers/phase2Db';
import type { Fixture } from './helpers/phase2Db';
import { runRecovery } from '../../scripts/recover-delivery.mts';

async function committed(f:Fixture){
 const messageId=randomUUID();
 const delivery={gateway:'meta',messageId,chatId:f.chatId,rawFrom:f.requester,text:'makan fixture',repliedToId:null,receivedAt:'2026-10-13T01:00:00Z',providerAt:null,fingerprint:'b'.repeat(64)};
 const [{value}]=await sql<{value:{ids:string[]}}>('select public.ingest_bot_messages($1::jsonb) as value',[JSON.stringify([delivery])]);
 const [{claim}]=await sql<{claim:{id:string;fence:string}}>('select public.claim_bot_message($1) as claim',[value.ids[0]]);
 const command={kind:'create',accountId:f.accountId,recordedByName:'Fixture',rows:[{categoryId:f.categoryId,amount:'125.25',type:'expense',description:'original receipt',date:'2026-10-13'}]};
 await sql('select public.save_bot_command($1,$2,$3::jsonb)',[claim.id,claim.fence,JSON.stringify(command)]);
 const [{result}]=await sql<{result:{outboundIds:string[];transactionIds:string[]}}> ('select public.commit_bot_command($1,$2) as result',[claim.id,claim.fence]);
 return {messageId,...result};
}
beforeAll(()=>applyPhase2MigrationsThrough('202610130003_delivery_recovery.sql'));
afterAll(closeFixture);
it('freezes the canonical receipt before a later dashboard edit and settles provider mapping atomically',async()=>{
 const f=await seedLinkedFixture(),created=await committed(f),outbound=created.outboundIds[0];
 const [snapshot]=await sql<{reply_payload:unknown}>('select reply_payload from public.bot_outbound where id=$1',[outbound]);
 expect((await sql<{ok:boolean}>('select public.freeze_bot_reply($1,$2) as ok',[outbound,'fixture frozen receipt']))[0].ok).toBe(true);
 expect((await sql<{ok:boolean}>('select public.freeze_bot_reply($1,$2) as ok',[outbound,'different render']))[0].ok).toBe(false);
 await sql("update public.transactions set description='dashboard edit',amount=999 where id=$1",[created.transactionIds[0]]);
 expect(snapshot.reply_payload).toMatchObject({code:'created',rows:[{description:'original receipt',amount:'125.25'}]});
 const [{claim}]=await sql<{claim:{id:string;fence:number;attempt_id:string}}> ('select public.claim_bot_outbound($1) as claim',[outbound]);expect(claim.id).toBe(outbound);
 expect((await sql<{claim:unknown}>('select public.claim_bot_outbound($1) as claim',[outbound]))[0].claim).toBeNull();
 expect((await sql<{ok:boolean}>('select public.settle_bot_outbound($1,$2,$3,$4::jsonb) as ok',[outbound,claim.fence,claim.attempt_id,JSON.stringify({kind:'accepted',providerMessageId:'provider-fixture-accepted'})]))[0].ok).toBe(true);
 const [{mapping}]=await sql<{mapping:Array<{index:number;transactionId:string|null}>}>('select public.lookup_bot_receipt($1,$2,$3) as mapping',[f.accountId,'meta','provider-fixture-accepted']);
 expect(mapping).toEqual([{index:1,transactionId:created.transactionIds[0]}]);
});
it('holds uncertain sends until explicit recovery without changing financial records',async()=>{
 const f=await seedLinkedFixture(),created=await committed(f),outbound=created.outboundIds[0];
 await sql('select public.freeze_bot_reply($1,$2)',[outbound,'receipt']);
 const [{claim}]=await sql<{claim:{fence:number;attempt_id:string}}> ('select public.claim_bot_outbound($1) as claim',[outbound]);
 await sql('select public.settle_bot_outbound($1,$2,$3,$4::jsonb)',[outbound,claim.fence,claim.attempt_id,JSON.stringify({kind:'uncertain',code:'transport_unknown'})]);
 expect((await sql<{claim:unknown}>('select public.claim_bot_outbound($1) as claim',[outbound]))[0].claim).toBeNull();
 expect((await sql<{result:{code:string}}>('select public.recover_bot_outbound($1,$2,$3) as result',[outbound,'resend-uncertain','']))[0].result.code).toBe('invalid_transition');
 const result=await runRecovery(['resend-uncertain',outbound,'--acknowledge-duplicate-risk'],async(id,action,argument)=>{
  const [row]=await sql<{data:unknown}>('select public.recover_bot_outbound($1,$2,$3) as data',[id,action,argument]);return {data:row.data,error:null};
 });
 expect(result).toMatchObject({ok:true,code:'queued'});
 const [unchanged]=await sql<{ids:string[];amount:string}>('select array_agg(id::text) as ids,max(amount)::text as amount from public.transactions where account_id=$1',[f.accountId]);
 expect(unchanged).toEqual({ids:created.transactionIds,amount:'125.25'});
 const [{again}]=await sql<{again:{attempt_id:string;fence:number}}> ('select public.claim_bot_outbound($1) as again',[outbound]);expect(again.fence).toBeGreaterThan(claim.fence);expect(again.attempt_id).not.toBe(claim.attempt_id);
});
it('an interrupted send lease becomes uncertain and cannot be automatically retried',async()=>{
 const f=await seedLinkedFixture(),created=await committed(f),outbound=created.outboundIds[0];
 await sql('select public.freeze_bot_reply($1,$2)',[outbound,'receipt']);
 await sql('select public.claim_bot_outbound($1) as claim',[outbound]);
 await sql("update public.bot_outbound set lease_until=clock_timestamp()-interval '1 second' where id=$1",[outbound]);
 expect((await sql<{claim:unknown}>('select public.claim_bot_outbound($1) as claim',[outbound]))[0].claim).toBeNull();
 const [row]=await sql<{state:string;diagnostic_code:string}>('select state,diagnostic_code from public.bot_outbound where id=$1',[outbound]);
 expect(row).toEqual({state:'uncertain',diagnostic_code:'interrupted_send'});
});
it('accepted prompt IDs bind only the current pending request and never extend expiry',async()=>{
 const f=await seedLinkedFixture(),created=await committed(f),messageId=randomUUID();
 const delivery={gateway:'meta',messageId,chatId:f.chatId,rawFrom:f.requester,text:'hapus',repliedToId:created.messageId,receivedAt:'2026-10-13T01:01:00Z',providerAt:null,fingerprint:'c'.repeat(64)};
 const [{value}]=await sql<{value:{ids:string[]}}> ('select public.ingest_bot_messages($1::jsonb) as value',[JSON.stringify([delivery])]);
 const [{claim}]=await sql<{claim:{id:string;fence:string}}> ('select public.claim_bot_message($1) as claim',[value.ids[0]]);
 await sql('select public.save_bot_command($1,$2,$3::jsonb)',[claim.id,claim.fence,JSON.stringify({kind:'delete_prompt',accountId:f.accountId,transactionId:created.transactionIds[0]})]);
 const [{outcome}]=await sql<{outcome:{outboundIds:string[]}}> ('select public.commit_bot_command($1,$2) as outcome',[claim.id,claim.fence]);
 const outbound=outcome.outboundIds[0];const [old]=await sql<{id:string;expires_at:string}>('select id,expires_at from public.pending_actions where account_id=$1',[f.accountId]);
 await sql('delete from public.pending_actions where id=$1',[old.id]);
 const replacement=randomUUID();await sql("insert into public.pending_actions(id,account_id,transaction_id,action,expires_at,requested_by_phone,wa_chat_id) values($1,$2,$3,'DELETE',$4,$5,$6)",[replacement,f.accountId,created.transactionIds[0],old.expires_at,f.requester,f.chatId]);
 await sql('select public.freeze_bot_reply($1,$2)',[outbound,'confirmation']);
 const [{claim:outbox}]=await sql<{claim:{fence:number;attempt_id:string}}> ('select public.claim_bot_outbound($1) as claim',[outbound]);
 await sql('select public.settle_bot_outbound($1,$2,$3,$4::jsonb)',[outbound,outbox.fence,outbox.attempt_id,JSON.stringify({kind:'accepted',providerMessageId:'prompt-fixture-id'})]);
 const [pending]=await sql<{id:string;confirmation_message_id:string|null;expires_at:string}>('select id,confirmation_message_id,expires_at from public.pending_actions where id=$1',[replacement]);
 expect(pending).toEqual({id:replacement,confirmation_message_id:null,expires_at:old.expires_at});
});
it('outbound tables and RPCs remain service-role only',async()=>{
 const f=await seedLinkedFixture(),created=await committed(f),outbound=created.outboundIds[0];
 await expect(sqlAs('anon','select id from public.bot_outbound where id=$1',[outbound])).rejects.toThrow();
 await expect(sqlAs('anon','select public.claim_bot_outbound($1)',[outbound])).rejects.toThrow();
 const [{ok}]=await sqlAs<{ok:boolean}>('service_role','select public.freeze_bot_reply($1,$2) as ok',[outbound,'role checked']);
 expect(ok).toBe(true);
});
it('stores bounded retry-after delays and lets operators resume a rejected task',async()=>{
 const f=await seedLinkedFixture(),created=await committed(f),outbound=created.outboundIds[0];
 await sql('select public.freeze_bot_reply($1,$2)',[outbound,'receipt']);
 const [{claim}]=await sql<{claim:{fence:number;attempt_id:string}}> ('select public.claim_bot_outbound($1) as claim',[outbound]);
 await sql('select public.settle_bot_outbound($1,$2,$3,$4::jsonb)',[outbound,claim.fence,claim.attempt_id,JSON.stringify({kind:'rejected',retryable:true,code:'meta_throughput',retryAfterSeconds:30})]);
 const [row]=await sql<{state:string;next_attempt_at:Date}>('select state,next_attempt_at from public.bot_outbound where id=$1',[outbound]);
 expect(row.state).toBe('rejected');expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now()+25_000);
 const result=await runRecovery(['resume',outbound],async(id,action,argument)=>{
  const [record]=await sql<{data:unknown}>('select public.recover_bot_outbound($1,$2,$3) as data',[id,action,argument]);return {data:record.data,error:null};
 });
 expect(result).toMatchObject({ok:true,code:'queued'});
 const [resumed]=await sql<{state:string;attempt:number}>('select state,attempt from public.bot_outbound where id=$1',[outbound]);
 expect(resumed).toEqual({state:'pending',attempt:0});
});
it('claims bounded due work once and records the next wake before enqueueing',async()=>{
 const f=await seedLinkedFixture(),created=await committed(f),messageId=randomUUID();
 const delivery={gateway:'meta',messageId,chatId:f.chatId,rawFrom:f.requester,text:'queued receipt',repliedToId:null,receivedAt:'2026-10-13T01:00:00Z',providerAt:null,fingerprint:'d'.repeat(64)};
 const [{value}]=await sql<{value:{ids:string[]}}> ('select public.ingest_bot_messages($1::jsonb) as value',[JSON.stringify([delivery])]);
 const [{work}]=await sql<{work:{inboxIds:string[];outboundIds:string[]}}> ('select public.claim_bot_recovery_work(50,50,60) as work');
 expect(work.inboxIds).toEqual(value.ids);expect(work.outboundIds).toContain(created.outboundIds[0]);
 const [outbound]=await sql<{next_wake_at:Date}>('select next_wake_at from public.bot_outbound where id=$1',[created.outboundIds[0]]);
 expect(outbound.next_wake_at.getTime()).toBeGreaterThan(Date.now()+55_000);
 const [{again}]=await sql<{again:{inboxIds:string[];outboundIds:string[]}}> ('select public.claim_bot_recovery_work(50,50,60) as again');
 expect(again).toEqual({inboxIds:[],outboundIds:[]});
});
