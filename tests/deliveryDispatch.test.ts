import { expect,it,vi } from 'vitest';
const state=vi.hoisted(()=>({send:vi.fn(),settle:vi.fn(),account:vi.fn()}));
vi.mock('../src/services/whatsapp',()=>({sendWA:state.send}));
vi.mock('../src/services/supabase',()=>({supabase:{from:()=>({select:()=>({eq:()=>({eq:()=>({eq:()=>({maybeSingle:state.account})})})})})}}));
vi.mock('../src/delivery/repository',()=>({claimOutbound:vi.fn(),freezeReply:vi.fn(),settleOutbound:state.settle}));
import { dispatchClaim } from '../src/delivery/dispatch';
import type { OutboundClaim } from '../src/delivery/types';
const claim:OutboundClaim={id:'123e4567-e89b-42d3-a456-426614174000',inboxId:'123e4567-e89b-42d3-a456-426614174001',accountId:'123e4567-e89b-42d3-a456-426614174002',gateway:'meta',destination:'fixture-chat',kind:'receipt',batchId:null,pendingId:null,expiresAt:null,payload:{language:'en',kind:'receipt',code:'created',text:null,rows:[],categoryName:null,categoryType:null,accountName:null},text:'frozen receipt',fence:4,attemptId:'123e4567-e89b-42d3-a456-426614174003'};
it('retries accepted-ID persistence using the known ID without a second provider send',async()=>{
 state.account.mockResolvedValue({data:{id:claim.accountId},error:null});
 state.send.mockResolvedValue({kind:'accepted',providerMessageId:'provider-fixture-id'});
 state.settle.mockRejectedValueOnce(new Error('temporary database outage')).mockResolvedValueOnce(undefined);
 await dispatchClaim(claim);
 expect(state.send).toHaveBeenCalledTimes(1);
 expect(state.settle).toHaveBeenCalledTimes(2);
 expect(state.settle).toHaveBeenLastCalledWith(claim,{kind:'accepted',providerMessageId:'provider-fixture-id'});
});
