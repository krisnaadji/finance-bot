import { logger, redactPhone } from '../utils/logger';
import type { Gateway } from '../intake/types';
import type { SendOutcome } from '../delivery/types';

const MAX_RESPONSE_BYTES=32*1024;
async function responseJson(response:Response):Promise<Record<string,unknown>|null>{
  const reader=response.body?.getReader();if(!reader)return null;
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_RESPONSE_BYTES){await reader.cancel();return null;}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{const data=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));return data&&typeof data==='object'&&!Array.isArray(data)?data:null;}catch{return null;}
}
function fonnteId(value:unknown):string|null{
  if(typeof value==='string'&&value.trim())return value.trim();
  if(Array.isArray(value)&&typeof value[0]==='string'&&value[0].trim())return value[0].trim();
  return null;
}
function fonnteOutcome(status:number,data:Record<string,unknown>|null,retryAfterSeconds:number|null):SendOutcome{
  if(!data)return {kind:'uncertain',code:'malformed_provider_response'};
  if(status>=200&&status<300&&(data.status===true||data.Status===true)){const id=fonnteId(data.id);return id?{kind:'accepted',providerMessageId:id}:{kind:'uncertain',code:'missing_provider_id'};}
  if(status<500&&(data.status===false||data.Status===false)){
    const reason=typeof data.reason==='string'?data.reason.toLowerCase():'';
    if(reason==='insufficient quota')return {kind:'rejected',retryable:true,code:'provider_quota',retryAfterSeconds};
    if(reason==='invalid token'||reason==='devices must belong to an account')return {kind:'rejected',retryable:false,code:'provider_credentials',retryAfterSeconds:null};
    if(reason==='input invalid'||reason==='target invalid'||reason==='json format invalid')return {kind:'rejected',retryable:false,code:'provider_invalid_request',retryAfterSeconds:null};
  }
  return {kind:'uncertain',code:status>=500?'provider_server_unknown':'provider_rejection_unclassified'};
}
function metaOutcome(status:number,data:Record<string,unknown>|null,retryAfterSeconds:number|null):SendOutcome{
  if(status>=200&&status<300){const messages=data?.messages;const id=Array.isArray(messages)&&messages[0]&&typeof messages[0]==='object'?(messages[0] as Record<string,unknown>).id:null;
    return typeof id==='string'&&id.trim()?{kind:'accepted',providerMessageId:id.trim()}:{kind:'uncertain',code:'missing_provider_id'};}
  const error=data?.error;const code=error&&typeof error==='object'?(error as Record<string,unknown>).code:null;
  if(typeof code==='number'){
    if([130429,131056].includes(code))return {kind:'rejected',retryable:true,code:code===130429?'meta_throughput':'meta_recipient_throttle',retryAfterSeconds};
    if([0,3,10,100,130403,131005,131008,131009,131021,131026,131031,131047,131048,131050,131051].includes(code))return {kind:'rejected',retryable:false,code:'meta_rejected',retryAfterSeconds:null};
    if([2,4,80007,131000,131016,133004].includes(code))return {kind:'rejected',retryable:true,code:'meta_temporary',retryAfterSeconds};
  }
  return {kind:'uncertain',code:status>=500?'provider_server_unknown':'provider_rejection_unclassified'};
}
function retryAfter(response:Response):number|null{
  const value=response.headers.get('retry-after');if(!value)return null;
  const seconds=Number(value);const parsed=Number.isFinite(seconds)?seconds:(Date.parse(value)-Date.now())/1000;
  return Number.isFinite(parsed)&&parsed>=1&&parsed<=3600?Math.ceil(parsed):null;
}
export async function sendWA(to:string,text:string,gateway:Gateway='meta'):Promise<SendOutcome>{
  logger.debug('whatsapp','sending',{gateway,to:redactPhone(to)});
  let response:Response,data:Record<string,unknown>|null;
  try{
    if(gateway==='fonnte'){
      const form=new URLSearchParams();form.append('target',to);form.append('message',text);form.append('delay','1');
      response=await fetch('https://api.fonnte.com/send',{method:'POST',headers:{Authorization:process.env.FONNTE_TOKEN!},body:form,signal:AbortSignal.timeout(20_000)});
    }else{
      response=await fetch('https://graph.facebook.com/v22.0/'+process.env.WA_PHONE_NUMBER_ID+'/messages',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.WA_ACCESS_TOKEN},
        body:JSON.stringify({messaging_product:'whatsapp',to,type:'text',text:{body:text,preview_url:false}}),signal:AbortSignal.timeout(20_000)});
    }
    data=await responseJson(response);
  }catch{return {kind:'uncertain',code:'transport_unknown'};}
  const delay=retryAfter(response),outcome=gateway==='fonnte'?fonnteOutcome(response.status,data,delay):metaOutcome(response.status,data,delay);
  if(outcome.kind!=='accepted')logger.warn('whatsapp','send_not_accepted',{gateway,code:outcome.code});
  return outcome;
}
