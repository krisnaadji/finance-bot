import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SecurityDb,accountId,expenseId,seedSecurityDb,txnId} from './helpers/securityDb';
import type {ReplySnapshot} from '../src/delivery/types';
const state=vi.hoisted(()=>({db:null as unknown as SecurityDb,freeze:vi.fn(),claim:vi.fn(),send:vi.fn(),settle:vi.fn(),reads:[] as string[]}));
vi.mock('../src/services/supabase',()=>({supabase:{from:(table:string)=>{state.reads.push(table);return state.db.from(table);},rpc:(name:string,args:Record<string,unknown>)=>state.db.rpc(name,args)}}));
vi.mock('../src/services/whatsapp',()=>({sendWA:state.send}));
vi.mock('../src/delivery/repository',()=>({freezeReply:state.freeze,claimOutbound:state.claim,settleOutbound:state.settle}));
import {dispatchOutbound} from '../src/delivery/dispatch';
const outboundId='50000000-0000-4000-8000-000000000001';
const childId='20000000-0000-4000-8000-000000000011';
function snapshot():ReplySnapshot{return {language:'en',kind:'receipt',code:'created',text:null,categoryName:null,categoryType:null,accountName:null,rows:[1,2].map(index=>({index,id:txnId,categoryId:childId,amount:'40.00',type:'expense',description:`meal ${index}`,date:'2026-04-15',categoryName:'Frozen Food / Frozen Dining'}))};}
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-04-15T03:00:00Z'));
 state.db=seedSecurityDb();state.reads=[];state.freeze.mockReset();state.claim.mockReset().mockResolvedValue(null);state.send.mockReset();state.settle.mockReset();
 state.db.tables.categories.push({...state.db.tables.categories[0],id:childId,parent_id:expenseId,code:null,name_id:'Makan',name_en:'Dining'});
 state.db.tables.budgets=[{account_id:accountId,category_id:expenseId,amount:'100.00'}];
 state.db.rpcResponses.finance_budget_spending={spendingByCategoryId:{[expenseId]:'120.00'}};
 state.db.tables.bot_outbound=[{id:outboundId,account_id:accountId,reply_payload:snapshot(),text:null,state:'pending'}];
 state.freeze.mockImplementation(async (_id:string,text:string)=>{state.db.tables.bot_outbound[0].text=text;return text;});
});
afterEach(()=>vi.useRealTimers());
it('freezes one root warning for several children and retries the exact frozen receipt',async()=>{
 await dispatchOutbound(outboundId);
 const text=state.db.tables.bot_outbound[0].text as string;
 expect(text).toContain('Frozen Food / Frozen Dining');
 expect(text.match(/budget exceeded/g)).toHaveLength(1);
 expect(text).toContain('120%');
 expect(state.db.rpcCalls).toEqual([{name:'finance_budget_spending',args:{p_account_id:accountId,p_from:'2026-04-01',p_to:'2026-04-15'}}]);
 state.db.tables.categories=[];state.db.tables.budgets=[];state.reads=[];
 await dispatchOutbound(outboundId);
 expect(state.freeze).toHaveBeenCalledTimes(1);
 expect(state.reads).toEqual(['bot_outbound']);
 expect(state.db.tables.bot_outbound[0].text).toBe(text);
 expect(state.db.writes).toEqual([]);
});
it('freezes a localized warning failure without losing the committed receipt',async()=>{
 state.db.failures.push({table:'categories',mode:'read',code:'08006'});
 await dispatchOutbound(outboundId);
 const text=state.db.tables.bot_outbound[0].text as string;
 expect(text).toContain('meal 1');
 expect(text).toContain('\n\n');
 expect(text).not.toContain('\\n\\n');
 expect(state.freeze).toHaveBeenCalledTimes(1);
 expect(state.db.writes).toEqual([]);
});
it.each(['historical','old snapshot','ordinary','income'])('does not query warning dependencies for %s replies',async(kind)=>{
 const reply=snapshot();
 if(kind==='historical')reply.rows.forEach(r=>r.date='2026-03-31');
 if(kind==='old snapshot')reply.rows.forEach(r=>delete r.categoryId);
 if(kind==='ordinary'){reply.kind='ordinary';reply.code='reply';reply.text='hello';}
 if(kind==='income')reply.rows.forEach(r=>r.type='income');
 state.db.tables.bot_outbound[0].reply_payload=reply;
 await dispatchOutbound(outboundId);
 expect(state.reads).toEqual(['bot_outbound']);
 expect(state.db.rpcCalls).toEqual([]);
 expect(state.freeze).toHaveBeenCalledTimes(1);
});
