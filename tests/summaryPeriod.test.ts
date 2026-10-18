import {beforeEach,afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({categories:[] as Record<string,unknown>[],transactions:[] as Record<string,unknown>[],failed:false}));
vi.mock('../src/services/supabase',()=>({supabase:{from:(table:string)=>{
  const filters:Array<(r:Record<string,unknown>)=>boolean>=[]; let ascending=true,limit=Infinity;
  const result=()=>({data:(table==='categories'?state.categories:state.transactions).filter(r=>filters.every(f=>f(r))).sort((a,b)=>String(a.date).localeCompare(String(b.date))*(ascending?1:-1)).slice(0,limit),error:state.failed?{code:'08006'}:null});
  const q={select:()=>q,eq:(k:string,v:unknown)=>{filters.push(r=>r[k]===v);return q;},gte:(k:string,v:string)=>{filters.push(r=>String(r[k])>=v);return q;},lte:(k:string,v:string)=>{filters.push(r=>String(r[k])<=v);return q;},order:(_k:string,o:{ascending:boolean})=>{ascending=o.ascending;return q;},limit:(n:number)=>{limit=n;return q;},maybeSingle:async()=>{const r=result();return {...r,data:r.data[0]??null};},then:(resolve:(r:unknown)=>unknown)=>Promise.resolve(result()).then(resolve)};
  return q;
}}}));
import {resolveSummaryPeriod} from '../src/handlers/summaryPeriod';
const account='10000000-0000-4000-8000-000000000001',salary='20000000-0000-4000-8000-000000000001',bonus='20000000-0000-4000-8000-000000000002';
function markers(dates:string[],category_id=salary,account_id=account){return dates.map(date=>({date,category_id,account_id,type:'income'}));}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-04-15T03:00:00Z'));state.failed=false;state.categories=[{id:salary,account_id:account,code:'salary',type:'income',name_id:'Changed label',name_en:'Salary',is_active:false}];state.transactions=[];});
afterEach(()=>vi.useRealTimers());
it('keeps calendar as default and Jakarta today',async()=>{await expect(resolveSummaryPeriod('this_month',account)).resolves.toMatchObject({ok:true,from:'2026-04-01',to:'2026-04-15'});});
it('uses earliest selected salary and latest following-month salary, never bonus',async()=>{
 state.transactions=[...markers(['2026-03-27']),...markers(['2026-04-02'],bonus),...markers(['2026-04-06'])];
 await expect(resolveSummaryPeriod('salary_cycle',account,{salaryMonth:3,salaryYear:2026})).resolves.toMatchObject({ok:true,from:'2026-03-27',to:'2026-04-05'});
 state.transactions.push(...markers(['2026-04-10']));
 await expect(resolveSummaryPeriod('salary_cycle',account,{salaryMonth:3,salaryYear:2026})).resolves.toMatchObject({ok:true,from:'2026-03-27',to:'2026-04-09'});
});
it('skipped following month ends today, not before May salary',async()=>{state.transactions=markers(['2026-03-27','2026-05-06']);await expect(resolveSummaryPeriod('salary_cycle',account,{salaryMonth:3,salaryYear:2026})).resolves.toMatchObject({ok:true,to:'2026-04-15'});});
it('implicit selection uses latest regular salary month',async()=>{state.transactions=[...markers(['2026-03-27','2026-04-06']),...markers(['2026-04-14'],bonus)];await expect(resolveSummaryPeriod('salary_cycle',account)).resolves.toMatchObject({ok:true,from:'2026-04-06',to:'2026-04-15'});});
it('bonus and foreign salary never satisfy missing selected month',async()=>{state.transactions=[...markers(['2026-03-27'],bonus),...markers(['2026-03-28'],salary,'10000000-0000-4000-8000-000000000002')];await expect(resolveSummaryPeriod('salary_cycle',account,{salaryMonth:3,salaryYear:2026})).resolves.toEqual({ok:false,reason:'salary_not_found'});});
it.each([['2024-02-29','2024-03-05','2024-03-04',2,2024],['2025-12-27','2026-01-06','2026-01-05',12,2025]] as const)('preserves civil boundaries %s',async(from,next,to,salaryMonth,salaryYear)=>{state.transactions=markers([from,next]);await expect(resolveSummaryPeriod('salary_cycle',account,{salaryMonth,salaryYear})).resolves.toMatchObject({ok:true,from,to});});
it('distinguishes dependency failure from missing salary',async()=>{state.failed=true;await expect(resolveSummaryPeriod('salary_cycle',account)).resolves.toEqual({ok:false,reason:'query_failed'});});
