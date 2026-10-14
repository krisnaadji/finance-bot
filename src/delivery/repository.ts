import { supabase } from '../services/supabase';
import type { SendOutcome, OutboundClaim } from './types';
import { decodeReplySnapshot } from './types';
import { isRecord, isUuid } from '../utils/financialValidation';
import type { Gateway } from '../intake/types';

export async function freezeReply(id:string,text:string):Promise<string>{
  const {data,error}=await supabase.rpc('freeze_bot_reply',{p_outbound_id:id,p_text:text});
  if(error)throw new Error('reply_freeze_unavailable');
  const row=await supabase.from('bot_outbound').select('text').eq('id',id).maybeSingle();
  if(row.error||typeof row.data?.text!=='string')throw new Error('reply_freeze_unavailable');
  return row.data.text;
}
export async function claimOutbound(id:string):Promise<OutboundClaim|null>{
  const {data,error}=await supabase.rpc('claim_bot_outbound',{p_outbound_id:id});
  if(error)throw new Error('outbound_claim_unavailable');if(data===null)return null;
  if(!isRecord(data)||!isUuid(data.id)||!isUuid(data.inbox_id)||!(data.account_id===null||isUuid(data.account_id))||
    (data.gateway!=='meta'&&data.gateway!=='fonnte')||typeof data.destination!=='string'||
    !['ordinary','receipt','help','confirmation'].includes(String(data.kind))||!(data.batch_id===null||isUuid(data.batch_id))||
    !(data.pending_id===null||isUuid(data.pending_id))||!(data.expires_at===null||typeof data.expires_at==='string')||
    typeof data.text!=='string'||typeof data.fence!=='number'||!Number.isSafeInteger(data.fence)||!isUuid(data.attempt_id))throw new Error('invalid_outbound_claim');
  return {id:data.id,inboxId:data.inbox_id,accountId:data.account_id,gateway:data.gateway as Gateway,destination:data.destination,
    kind:data.kind as OutboundClaim['kind'],batchId:data.batch_id,pendingId:data.pending_id,expiresAt:data.expires_at,
    payload:decodeReplySnapshot(data.reply_payload),text:data.text,fence:data.fence,attemptId:data.attempt_id};
}
export async function settleOutbound(claim:OutboundClaim,outcome:SendOutcome):Promise<void>{
  const {data,error}=await supabase.rpc('settle_bot_outbound',{p_outbound_id:claim.id,p_fence:claim.fence,p_attempt_id:claim.attemptId,p_outcome:outcome});
  if(error||data!==true)throw new Error('outbound_settlement_unavailable');
}
