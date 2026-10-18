import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  budgets: [] as unknown[],
  warn: vi.fn(),
}));
vi.mock('../src/services/supabase', () => ({
  supabase: {
    rpc: state.rpc,
    from: vi.fn(() => {
      const query = {
        select: () => query,
        eq: () => query,
        then: (resolve: (result: unknown) => unknown) => Promise.resolve(resolve({
          data: state.budgets,
          error: null,
        })),
      };
      return query;
    }),
  },
}));
vi.mock('../src/utils/logger', () => ({ logger: { warn: state.warn } }));

import { summaryReply } from '../src/handlers/getSummary';
import { budgetWarnings } from '../src/handlers/transactionData';
import { decodeFinanceSummary } from '../src/services/reporting';
import { t } from '../src/i18n/bot';
import type { Category } from '../src/categories';

const accountId = '10000000-0000-4000-8000-000000000001';
const categoryOne = '20000000-0000-4000-8000-000000000001';
const categoryTwo = '20000000-0000-4000-8000-000000000002';
const transactionId = '30000000-0000-4000-8000-000000000001';
const account = { id: accountId } as never;
const category:Category={id:categoryOne,account_id:accountId,code:'expense.food',name_id:'Food',name_en:'Food',parent_id:null,type:'expense',is_active:true,is_custom:false,sort_order:0};

beforeEach(() => {
  state.rpc.mockReset();
  state.budgets = [];
  state.warn.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
});
afterEach(()=>vi.useRealTimers());

it('renders exact summary values and keeps same-named categories distinct by identity', async () => {
  state.rpc.mockResolvedValue({ data: {
    income: '10000000000000.01',
    expense: '0.30',
    net: '9999999999999.71',
    categories: [
      {id:categoryOne,name_id:'Food',name_en:'Food',amount:'0.10'},
      {id:categoryTwo,name_id:'Food',name_en:'Food',amount:'0.20'},
      {id:null,name_id:null,name_en:null,amount:'0.00'},
    ],
    spendingByCategoryId: { [categoryOne]: '0.10', [categoryTwo]: '0.20' },
    categoryDetails:[{parentId:categoryOne,categoryId:categoryOne,amount:'0.10'}],
    byMonth: { '2026-10': { income: '10000000000000.01', expense: '0.30' } },
    topExpenses:[{id:transactionId,date:'2026-10-14',description:'Snack',amount:'0.20',categories:category,parent:null}],
    topIncomes: [],
  }, error: null });

  const reply = await summaryReply({ action: 'GET_SUMMARY', payload: { period: 'this_month' } } as never,
    account, 'id', new Date('2026-10-14T12:00:00Z'));

  expect(reply).toContain('Ringkasan 2026-10-01 s/d 2026-10-14');
  expect(reply).toContain('Pemasukan  : +Rp10.000.000.000.000,01');
  expect(reply).toContain('Saldo      : +Rp9.999.999.999.999,71');
  expect(reply.match(/Food - Rp/g)).toHaveLength(2);
  expect(reply).toContain('Food - Rp0,20 (67%)');
  expect(reply).toContain('Food - Rp0,10 (33%)');
  expect(reply).toContain('Tanpa kategori - Rp0 (0%)');
  expect(state.rpc).toHaveBeenCalledWith('finance_summary', {
    p_account_id: accountId, p_from: '2026-10-01', p_to: '2026-10-14',
  });
});

it('rejects malformed summary RPC output at runtime', () => {
  expect(() => decodeFinanceSummary({ income: 1 })).toThrow('invalid_finance_summary');
});

it('keeps bilingual child metadata and rejects incomplete or mismatched parent projections',()=>{
  const child={...category,id:categoryTwo,parent_id:category.id,code:null,name_id:'Makan',name_en:'Dining'};
  const top={id:transactionId,date:'2026-10-14',description:'meal',amount:'0.20',categories:child,parent:category};
  const summary={income:'0.00',expense:'0.20',net:'-0.20',categories:[{id:category.id,name_id:category.name_id,name_en:category.name_en,amount:'0.20'}],categoryDetails:[{parentId:category.id,categoryId:child.id,amount:'0.20'}],spendingByCategoryId:{[category.id]:'0.20'},byMonth:{},topExpenses:[top],topIncomes:[]};
  expect(decodeFinanceSummary(summary).topExpenses[0]).toMatchObject({category:child,parent:category});
  expect(decodeFinanceSummary({...summary,categories:summary.categories.map(c=>({...c,name:'Legacy label'})),
    topExpenses:[{...top,category:'Legacy label'}]})).toEqual(decodeFinanceSummary(summary));
  expect(()=>decodeFinanceSummary({...summary,topExpenses:[{...top,parent:null}]})).toThrow();
  expect(()=>decodeFinanceSummary({...summary,topExpenses:[{...top,parent:{...category,account_id:'10000000-0000-4000-8000-000000000099'}}]})).toThrow();
});

it('uses exact Jakarta-month budget spending from one aggregate RPC', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T18:00:00Z'));
  state.budgets = [{ category_id: categoryOne, amount: '9999999999999.98' }];
  state.rpc.mockResolvedValue({ data: { spendingByCategoryId: { [categoryOne]: '9999999999999.99' } }, error: null });
  const warning = await budgetWarnings([{
    id: transactionId, account_id: accountId, amount: '0.01', type: 'expense',
    date: '2026-10-15', description: 'Snack', category_id: categoryOne,
  }], [category], accountId, 'en');
  vi.useRealTimers();

  expect(warning).toContain('Rp9.999.999.999.999,99 / Rp9.999.999.999.999,98 (100%)');
  expect(state.rpc).toHaveBeenCalledTimes(1);
  expect(state.rpc).toHaveBeenCalledWith('finance_budget_spending', {
    p_account_id: accountId, p_from: '2026-10-01', p_to: '2026-10-15',
  });
});

it('keeps warning-query failure optional and logs only the account identifier', async () => {
  state.budgets = [{ category_id: categoryOne, amount: '100.00' }];
  state.rpc.mockResolvedValue({ data: null, error: { code: 'unavailable' } });
  const warning = await budgetWarnings([{
    id: transactionId, account_id: accountId, amount: '90.00', type: 'expense',
    date: '2026-10-14', description: 'Private details', category_id: categoryOne,
  }], [category], accountId, 'en');

  expect(warning).toBe('\n\n' + t.en.budgetWarningUnavailable);
  expect(state.warn).toHaveBeenCalledWith('transactions', 'budget_warning_unavailable', { accountId });
});
