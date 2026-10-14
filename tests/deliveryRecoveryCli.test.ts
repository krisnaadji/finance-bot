import { expect, it, vi } from 'vitest';
import { parseRecoveryArgs, runRecovery } from '../scripts/recover-delivery.mts';
const id='123e4567-e89b-42d3-a456-426614174000';
it('requires an explicit outbound UUID and valid action arguments',()=>{
 expect(parseRecoveryArgs(['show',id])).toEqual({id,action:'show',argument:''});
 expect(parseRecoveryArgs(['show'])).toBeNull();
 expect(parseRecoveryArgs(['resend-uncertain',id])).toBeNull();
 expect(parseRecoveryArgs(['resend-uncertain',id,'--acknowledge-duplicate-risk'])).toEqual({id,action:'resend-uncertain',argument:'acknowledge-duplicate-risk'});
 expect(parseRecoveryArgs(['bind-id',id,''])).toBeNull();
});
it('routes only explicit recovery action without changing financial records',async()=>{
 const rpc=vi.fn(async(_id:string,_action:string,_argument:string)=>({data:{ok:false,code:'missing'},error:null}));
 await expect(runRecovery(['show',id],rpc)).resolves.toEqual({ok:false,code:'missing'});
 expect(rpc).toHaveBeenCalledWith(id,'show','');
});
