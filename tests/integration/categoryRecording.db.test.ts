import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { localSupabase } from './helpers/localSupabase';
import { initializePhase3Fixture, closeFixture, sql } from './helpers/phase3Db';
import { seedCategoryFixture, type CategoryFixture } from './categoryFixture';

const state=vi.hoisted(()=>({ai:vi.fn<(...args:unknown[])=>Promise<unknown>>(),send:vi.fn(),warningFailure:false,warningReads:0}));
vi.mock('../../src/services/supabase',()=>({supabase:{
  from:(table:string)=>localSupabase.from(table),
  rpc:(name:string,args:Record<string,unknown>)=>{
    if(name==='finance_budget_spending'){
      state.warningReads++;
      if(state.warningFailure) return Promise.resolve({data:null,error:new Error('local warning failure')});
    }
    return localSupabase.rpc(name,args);
  },
}}));
vi.mock('../../src/ai',()=>({callAI:state.ai}));
// All deliveries terminate here; this test never constructs a gateway client or reads credentials.
vi.mock('../../src/services/whatsapp',()=>({sendWA:state.send}));
import { ingest, claimInbox } from '../../src/intake/repository';
import { processInbox } from '../../src/processing/processor';
import { prepareMessage } from '../../src/processing/prepare';
import { saveCommand, commitCommand } from '../../src/processing/commit';
import { recoverDueWork } from '../../src/recovery';
import { businessDate } from '../../src/utils/businessDate';

beforeAll(initializePhase3Fixture);
beforeEach(()=>{
  vi.clearAllMocks();state.warningFailure=false;state.warningReads=0;
  state.send.mockImplementation(async()=>({kind:'accepted',providerMessageId:randomUUID()}));
});
afterAll(closeFixture);
async function recording(f:CategoryFixture,deferDispatch=false){
  await sql("update public.members set language_pref='en' where account_id=$1 and user_id=$2",[f.accountId,f.ownerId]);
  await sql('insert into public.budgets(account_id,category_id,amount) values($1,$2,1.00)',[f.accountId,f.parentId]);
  const date=businessDate(new Date());
  state.ai.mockResolvedValue({action:'CREATE_MULTIPLE',payload:{},transactions:[
    {amount:'1.10',type:'expense',description:'dinner',category_id:f.childId,date},
    {amount:'2.20',type:'expense',description:'groceries',category_id:f.otherChildId,date},
  ]});
  const {ids}=await ingest([{gateway:'meta',messageId:randomUUID(),chatId:f.chatId,rawFrom:f.requester,text:'local synthetic meals',
    repliedToId:null,receivedAt:new Date().toISOString(),providerAt:null,fingerprint:'d'.repeat(64)}]);
  if(deferDispatch){
    const claim=(await claimInbox(ids[0]))!;
    const command=await prepareMessage(claim);
    await saveCommand(claim,command);
    await commitCommand(claim,command);
  } else await processInbox(ids[0]);
  const [outbound]=await sql<{id:string;text:string;reply_payload:{rows:{id:string;categoryId:string;categoryName:string}[]}}>(
    'select id,text,reply_payload from public.bot_outbound where inbox_id=$1',[ids[0]]);
  return {inboxId:ids[0],outbound};
}
it('prepares IDs, commits exact child amounts, freezes one root warning, and replays after rename/deactivation without another write or send',async()=>{
  const f=await seedCategoryFixture(),{inboxId,outbound}=await recording(f);
  expect(outbound.reply_payload.rows.map(r=>r.categoryId)).toEqual([f.childId,f.otherChildId]);
  expect(outbound.reply_payload.rows.map(r=>r.categoryName)).toEqual(['Food / Dining Out','Food / Groceries']);
  expect(outbound.text.match(/budget exceeded/gi)).toHaveLength(1);
  expect(outbound.text).toContain('330%');
  expect(state.warningReads).toBe(1);expect(state.send).toHaveBeenCalledTimes(1);
  const original=await sql('select id,category_id,amount from public.transactions where account_id=$1 order by id',[f.accountId]);
  expect(original).toHaveLength(2);
  expect((await sql<{sum:string}>('select sum(amount)::text as sum from public.transactions where account_id=$1',[f.accountId]))[0].sum).toBe('3.30');
  await sql("update public.categories set name_en='Renamed root',is_active=false where id=$1",[f.parentId]);
  await processInbox(inboxId);
  expect(await sql('select id,category_id,amount from public.transactions where account_id=$1 order by id',[f.accountId])).toEqual(original);
  expect((await sql<{text:string}>('select text from public.bot_outbound where id=$1',[outbound.id]))[0].text).toBe(outbound.text);
  expect(state.ai).toHaveBeenCalledTimes(1);expect(state.send).toHaveBeenCalledTimes(1);expect(state.warningReads).toBe(1);
});
it('scheduled recovery freezes the same parent warning after a crash between commit and dispatch',async()=>{
  const f=await seedCategoryFixture(),{inboxId,outbound}=await recording(f,true);
  expect(outbound.text).toBeNull();expect(state.send).not.toHaveBeenCalled();
  const queueSend=vi.fn();
  await recoverDueWork({BOT_QUEUE:{send:queueSend}} as never);
  const [frozen]=await sql<{text:string;state:string}>('select text,state from public.bot_outbound where id=$1',[outbound.id]);
  expect(frozen.text.match(/budget exceeded/gi)).toHaveLength(1);
  expect(frozen.text).toContain('330%');expect(frozen.state).toBe('accepted');
  expect(queueSend).not.toHaveBeenCalled();expect(state.send).toHaveBeenCalledTimes(1);
  expect(state.warningReads).toBe(1);
  await processInbox(inboxId);
  expect(state.send).toHaveBeenCalledTimes(1);expect(state.warningReads).toBe(1);
});
it('keeps successful financial recording and freezes visible warning failure without retrying the financial operation',async()=>{
  const f=await seedCategoryFixture();state.warningFailure=true;
  const {inboxId,outbound}=await recording(f);
  expect(outbound.text).toMatch(/budget warnings could not be checked/i);
  expect(state.send).toHaveBeenCalledTimes(1);
  expect((await sql<{count:string}>('select count(*)::text as count from public.transactions where account_id=$1',[f.accountId]))[0].count).toBe('2');
  state.warningFailure=false;
  await processInbox(inboxId);
  expect(state.warningReads).toBe(1);expect(state.send).toHaveBeenCalledTimes(1);
  expect((await sql<{text:string}>('select text from public.bot_outbound where id=$1',[outbound.id]))[0].text).toBe(outbound.text);
});
