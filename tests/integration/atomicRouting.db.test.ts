import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { localSupabase } from './helpers/localSupabase';
import { initializePhase3Fixture, closeFixture, seedPhase3LinkedFixture as seedLinkedFixture, sql } from './helpers/phase3Db';
import type { Fixture } from './helpers/phase2Db';
const state=vi.hoisted(()=>({ai:vi.fn<(...args:unknown[])=>Promise<unknown>>()}));
vi.mock('../../src/services/supabase',()=>({supabase:{from:(table:string)=>localSupabase.from(table),rpc:(name:string,args:Record<string,unknown>)=>localSupabase.rpc(name,args)}}));
vi.mock('../../src/ai',()=>({callAI:state.ai}));
import { prepareMessage } from '../../src/processing/prepare';
import { ingest, claimInbox } from '../../src/intake/repository';
import { saveCommand, commitCommand } from '../../src/processing/commit';
import type { InboxClaim } from '../../src/intake/types';
beforeAll(()=>{vi.stubEnv('DELETE_CONFIRMATIONS_ENABLED','true');return initializePhase3Fixture();});
afterAll(async()=>{vi.unstubAllEnvs();await closeFixture();});
async function intake(f:Fixture,text:string,repliedToId:string|null=null):Promise<InboxClaim> {
  const {ids}=await ingest([{gateway:'meta',messageId:randomUUID(),chatId:f.chatId,rawFrom:f.requester,text,repliedToId,
    receivedAt:'2026-10-13T01:00:00Z',providerAt:null,fingerprint:'a'.repeat(64)}]);
  return (await claimInbox(ids[0]))!;
}
async function run(claim:InboxClaim) {
  const command=await prepareMessage(claim);
  await saveCommand(claim,command);
  return commitCommand(claim,command);
}
it('delete item two then edit original item three without redirecting the selection', async()=>{
  const f=await seedLinkedFixture();
  state.ai.mockResolvedValue({action:'CREATE_MULTIPLE',payload:{},transactions:[1,2,3].map(n=>({amount:`${n*10}.00`,type:'expense',category_id:f.categoryId,description:`item ${n}`,date:'2026-10-13'}))});
  const first=await intake(f,'three meals');
  const result=await run(first);
  await sql('delete from public.transactions where id=$1',[result.transactionIds[1]]);
  state.ai.mockResolvedValue({action:'EDIT_FROM_MULTIPLE',payload:{description:'third edited'},selection_index:3});
  expect((await run(await intake(f,'edit 3',first.delivery.messageId))).code).toBe('edited');
  const rows=await sql<{id:string;description:string}>('select id,description from public.transactions where account_id=$1 order by amount',[f.accountId]);
  expect(rows).toEqual([{id:result.transactionIds[0],description:'item 1'},{id:result.transactionIds[2],description:'third edited'}]);
});
it('plain yes consumes only the requesting sender pending action',async()=>{
  const f=await seedLinkedFixture();
  state.ai.mockResolvedValue({action:'CREATE_TRANSACTION',payload:{amount:'10.00',type:'expense',description:'meal',date:'2026-10-13'}});
  const first=await intake(f,'meal');
  const created=await run(first);
  state.ai.mockResolvedValue({action:'DELETE_TRANSACTION',payload:{}});
  await run(await intake(f,'hapus',first.delivery.messageId));
  await sql("update public.pending_actions set confirmation_message_id='fixture-confirmation' where account_id=$1",[f.accountId]);
  const result=await run(await intake(f,'ya'));
  expect(result.code).toBe('deleted');
  const [remaining]=await sql<{present:boolean}>('select exists(select 1 from public.transactions where id=$1) as present',[created.transactionIds[0]]);
  expect(remaining.present).toBe(false);
});
it('yes with an unrelated quote leaves the pending transaction untouched',async()=>{
  const f=await seedLinkedFixture();
  state.ai.mockResolvedValue({action:'CREATE_TRANSACTION',payload:{amount:'10.00',type:'expense',description:'meal',date:'2026-10-13'}});
  const first=await intake(f,'meal'),created=await run(first);
  state.ai.mockResolvedValue({action:'DELETE_TRANSACTION',payload:{}});
  await run(await intake(f,'hapus',first.delivery.messageId));
  await sql("update public.pending_actions set confirmation_message_id='fixture-confirmation' where account_id=$1",[f.accountId]);
  await run(await intake(f,'ya','unrelated-receipt'));
  const [remaining]=await sql<{present:boolean}>('select exists(select 1 from public.transactions where id=$1) as present',[created.transactionIds[0]]);
  expect(remaining.present).toBe(true);
});
