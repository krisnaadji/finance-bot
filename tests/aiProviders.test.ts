import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ categoryError: null as null | { code: string }, categories: [] as Record<string,unknown>[] }));
vi.mock('../src/services/supabase', () => ({ supabase: { from: () => {
  const builder: { select: () => unknown; eq: () => unknown; order: () => Promise<unknown> } = {
    select: () => builder, eq: () => builder,
    order: async () => ({ data: state.categories, error: state.categoryError }),
  }; return builder;
} } }));
import { callAI } from '../src/ai';
import { InvalidAICommand } from '../src/ai/validation';
import { fixtureAccount } from './helpers/mocks';
beforeEach(() => { state.categoryError = null; state.categories = []; vi.stubEnv('AI_API_KEY', 'disposable-test-key'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['groq', 'gemini'])('%s validates and normalizes provider JSON', async (provider) => {
  vi.stubEnv('AI_PROVIDER', provider);
  const content = JSON.stringify({ action: 'CREATE_TRANSACTION', payload: { amount: 35, type: 'Pengeluaran', date: '2026-10-12' } });
  const fetchMock = vi.fn(async () => Response.json(provider === 'groq'
    ? { choices: [{ message: { content } }] }
    : { candidates: [{ content: { parts: [{ text: content }] } }] }));
  vi.stubGlobal('fetch', fetchMock);
  expect((await callAI('lunch 35', fixtureAccount, 'en')).payload).toMatchObject({ amount: '35.00', type: 'expense' });
});
it.each(['groq', 'gemini'])('%s does not trust malformed or incomplete JSON', async (provider) => {
  vi.stubEnv('AI_PROVIDER', provider);
  for (const content of ['{', '{"action":"CREATE_TRANSACTION","payload":{}}']) {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(provider === 'groq'
      ? { choices: [{ message: { content } }] }
      : { candidates: [{ content: { parts: [{ text: content }] } }] })));
    await expect(callAI('bad input', fixtureAccount, 'en')).rejects.toBeInstanceOf(InvalidAICommand);
  }
});
it('category outage never fabricates an empty prompt catalog', async () => {
  state.categoryError = { code: '08006' }; const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  await expect(callAI('lunch', fixtureAccount, 'en')).rejects.toThrow('AI category lookup unavailable');
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['groq', 'gemini'])('%s rejects excess precision in the original numeric token', async (provider) => {
  vi.stubEnv('AI_PROVIDER', provider);
  const content = '{"action":"CREATE_TRANSACTION","payload":{"amount":9999999999999.991,"type":"expense","date":"2026-10-12"}}';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(provider === 'groq'
    ? { choices: [{ message: { content } }] }
    : { candidates: [{ content: { parts: [{ text: content }] } }] })));
  await expect(callAI('bad precision', fixtureAccount, 'en')).rejects.toBeInstanceOf(InvalidAICommand);
});

it.each(['groq','gemini'])('%s classifies against bilingual eligible IDs, excluding inactive-parent descendants',async(provider)=>{
  vi.stubEnv('AI_PROVIDER',provider);
  const parent={id:'20000000-0000-4000-8000-000000000021',account_id:fixtureAccount.id,code:'expense.food',name_id:'Makanan',name_en:'Food',parent_id:null,type:'expense',is_custom:false,is_active:true,sort_order:0};
  const child={...parent,id:'20000000-0000-4000-8000-000000000022',code:'expense.food.dining_out',parent_id:parent.id,name_id:'Makan di Luar',name_en:'Dining Out'};
  const disabled={...parent,id:'20000000-0000-4000-8000-000000000023',code:null,is_active:false};
  const hidden={...child,id:'20000000-0000-4000-8000-000000000024',parent_id:disabled.id,code:null};
  state.categories=[parent,child,disabled,hidden];
  const content=JSON.stringify({action:'CREATE_TRANSACTION',payload:{amount:'30000.00',type:'expense',category_id:child.id,date:'2026-04-15',description:'warteg'}});
  const fetchMock=vi.fn(async(_url:string,_options:RequestInit)=>Response.json(provider==='groq'?{choices:[{message:{content}}]}:{candidates:[{content:{parts:[{text:content}]}}]}));
  vi.stubGlobal('fetch',fetchMock);
  expect((await callAI('makan di warteg 30rb',fixtureAccount,'en')).payload).toMatchObject({amount:'30000.00',category_id:child.id});
  const request=JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
  const prompt=provider==='groq'?request.messages[0].content:request.contents[0].parts[0].text;
  const catalog=prompt.split('\n').filter((line:string)=>line.startsWith('{"id":')).map((line:string)=>JSON.parse(line));
  expect(catalog.map((row:{id:string})=>row.id)).toEqual([parent.id,child.id]);
  expect(catalog[1]).toMatchObject({parent_id:parent.id,path_id:'Makanan / Makan di Luar',path_en:'Food / Dining Out'});
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
