import { sendWA } from '../services/whatsapp';
import { renderReply } from './render';
import { claimOutbound, freezeReply, settleOutbound } from './repository';
import type { OutboundClaim } from './types';
import { supabase } from '../services/supabase';
import { decodeReplySnapshot } from './types';
import { categoryColumns, decodeCategory } from '../categories';
import { budgetWarnings, type CanonicalTxn } from '../handlers/transactionData';
import { t } from '../i18n/bot';
import { currentMonthRange } from '../utils/businessDate';

export async function dispatchClaim(claim:OutboundClaim):Promise<void>{
  if(claim.accountId!==null){
    const {data,error}=await supabase.from('accounts').select('id').eq('id',claim.accountId).eq('wa_chat_id',claim.destination).eq('is_active',true).maybeSingle();
    if(error)throw new Error('outbound_access_check_unavailable');
    if(!data){await settleOutbound(claim,{kind:'rejected',retryable:false,code:'access_changed',retryAfterSeconds:null});return;}
  }
  const outcome=await sendWA(claim.destination,claim.text,claim.gateway);
  for(let attempt=0;attempt<3;attempt++){
    try{await settleOutbound(claim,outcome);return;}
    catch(error){if(attempt===2)throw error;}
  }
}
export async function dispatchOutbound(id:string):Promise<void>{
  const row=await supabase.from('bot_outbound').select('id,account_id,reply_payload,text,state').eq('id',id).maybeSingle();
  if(row.error||!row.data)throw new Error('outbound_load_unavailable');
  const outbound=row.data;
  let text=outbound.text;
  if(text===null){
    const snapshot=decodeReplySnapshot(outbound.reply_payload);
    let rendered=renderReply(snapshot);
    const { from, to } = currentMonthRange();
    const rows=snapshot.rows.filter(r=>r.id!==null && r.type==='expense' && r.categoryId && r.date>=from && r.date<=to).map(r=>({
      id:r.id!,account_id:outbound.account_id,category_id:r.categoryId!,amount:r.amount,type:r.type,description:r.description,date:r.date,
    })) as CanonicalTxn[];
    if (outbound.account_id && ['created','edited'].includes(snapshot.code) && rows.length) {
      try {
        const cats=await supabase.from('categories').select(categoryColumns).eq('account_id',outbound.account_id);
        if(cats.error || !Array.isArray(cats.data)) throw new Error('category_lookup_unavailable');
        rendered+=await budgetWarnings(rows,cats.data.map(c=>decodeCategory(c,outbound.account_id)),outbound.account_id,snapshot.language);
      } catch { rendered+='\n\n'+t[snapshot.language].budgetWarningUnavailable; }
    }
    text=await freezeReply(id,rendered);
  }
  if(typeof text!=='string')throw new Error('outbound_text_missing');
  const claim=await claimOutbound(id);if(!claim)return;
  await dispatchClaim({...claim,text});
}
