import { createClient } from '@supabase/supabase-js';

export type RecoveryAction='show'|'resume'|'bind-id'|'resend-uncertain'|'resolve';
export function parseRecoveryArgs(args:string[]):{id:string;action:RecoveryAction;argument:string}|null{
 const [action,id,value,extra]=args;
 if(!['show','resume','bind-id','resend-uncertain','resolve'].includes(action??'')||
   !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id??''))return null;
 const selected=action as RecoveryAction;
 if(selected==='show'||selected==='resume')return args.length===2?{id,action:selected,argument:''}:null;
 if(selected==='bind-id')return args.length===3&&!!value?.trim()&&value.length<=512?{id,action:selected,argument:value.trim()}:null;
 if(selected==='resend-uncertain')return args.length===3&&value==='--acknowledge-duplicate-risk'?{id,action:selected,argument:'acknowledge-duplicate-risk'}:null;
 return args.length===3&&(value==='rejected'||value==='discard')?{id,action:selected,argument:value}:null;
}
export async function runRecovery(args:string[],rpc:(id:string,action:RecoveryAction,argument:string)=>Promise<{data:unknown;error:unknown}>):Promise<unknown>{
 const parsed=parseRecoveryArgs(args);if(!parsed)throw new Error('Usage: recover-delivery <show|resume|bind-id|resend-uncertain|resolve> <outbound-uuid> [provider-id|--acknowledge-duplicate-risk|rejected|discard]');
 const {data,error}=await rpc(parsed.id,parsed.action,parsed.argument);if(error)throw new Error('delivery_recovery_unavailable');return data;
}
async function main(){
 const parsed=parseRecoveryArgs(process.argv.slice(2));if(!parsed)throw new Error('Invalid action or arguments. Use resend-uncertain with --acknowledge-duplicate-risk to accept duplicate-send risk.');
 const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_KEY;
 if(!url||!key)throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the explicitly supplied operator environment. No dotenv file is loaded.');
 const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
 const result=await runRecovery(process.argv.slice(2),async(id,action,argument)=>await client.rpc('recover_bot_outbound',{p_outbound_id:id,p_action:action,p_argument:argument}));
 process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/recover-delivery.mts'))main().catch(error=>{process.stderr.write((error instanceof Error?error.message:'delivery_recovery_unavailable')+'\n');process.exitCode=1;});
