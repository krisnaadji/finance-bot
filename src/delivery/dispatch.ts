import { sendWA } from '../services/whatsapp';
import { renderReply } from './render';
import { claimOutbound, freezeReply, settleOutbound } from './repository';
import type { OutboundClaim } from './types';
import { supabase } from '../services/supabase';

export type DispatchTiming = { providerSendMs: number; settleMs: number };
export async function dispatchClaim(claim:OutboundClaim,onTiming?: (timing:DispatchTiming)=>void):Promise<void>{
  if(claim.accountId!==null){
    const {data,error}=await supabase.from('accounts').select('id').eq('id',claim.accountId).eq('wa_chat_id',claim.destination).eq('is_active',true).maybeSingle();
    if(error)throw new Error('outbound_access_check_unavailable');
    if(!data){await settleOutbound(claim,{kind:'rejected',retryable:false,code:'access_changed',retryAfterSeconds:null});return;}
  }
  const sendStart=onTiming?performance.now():0;
  const outcome=await sendWA(claim.destination,claim.text,claim.gateway);
  const providerSendMs=onTiming?Math.round(performance.now()-sendStart):0;
  const settleStart=onTiming?performance.now():0;
  for(let attempt=0;attempt<3;attempt++){
    try{
      await settleOutbound(claim,outcome);
      if(onTiming)onTiming({providerSendMs,settleMs:Math.round(performance.now()-settleStart)});
      return;
    }catch(error){if(attempt===2)throw error;}
  }
}
export async function dispatchOutbound(id:string):Promise<void>{
  const row=await supabase.from('bot_outbound').select('id,reply_payload,text,state').eq('id',id).maybeSingle();
  if(row.error||!row.data)throw new Error('outbound_load_unavailable');
  let text=row.data.text;
  if(text===null){text=await freezeReply(id,renderReply(row.data.reply_payload));}
  if(typeof text!=='string')throw new Error('outbound_text_missing');
  const claim=await claimOutbound(id);if(!claim)return;
  await dispatchClaim({...claim,text});
}
