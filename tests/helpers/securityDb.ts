export type Row = Record<string, unknown>;
type Result = { data: unknown; error: null | { code: string } };
type Mode = 'read' | 'insert' | 'update' | 'delete' | 'upsert';
function numericKey(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(value).trim());
  if (!match) return null;
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  const trimmed = digits.replace(/0+$/, '');
  const exponent = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length) + BigInt(digits.length - trimmed.length);
  digits = trimmed;
  return `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`;
}
export class SecurityDb {
  tables: Record<string, Row[]> = { accounts: [], members: [], categories: [], transactions: [], pending_actions: [], budgets: [], link_codes: [] };
  failures: { table: string; mode: Mode; skip?: number; zero?: boolean; code?: string }[] = [];
  writes: { table: string; mode: Mode }[] = [];
  rpcCalls: { name: string; args: Row }[] = [];
  clock = Date.now();
  rpcError: null | { code: string } = null;
  rpcResponses: Partial<Record<'load_bot_help_context' | 'finance_summary' | 'finance_budget_spending', unknown>> = {};
  sequence = 10;
  from(table: string): Query { return new Query(this, table); }
  async rpc(name: string, args: Row): Promise<Result> {
    this.rpcCalls.push({ name, args });
    if (name === 'consume_delete_confirmation') return this.consumeDeleteConfirmation(args);
    if (name === 'load_bot_help_context') {
      return { data: this.rpcResponses.load_bot_help_context ?? false, error: null };
    }
    if (name === 'finance_budget_spending') {
      return { data: this.rpcResponses.finance_budget_spending ?? { spendingByCategoryId: {} }, error: null };
    }
    if (name === 'finance_summary' && this.rpcResponses.finance_summary !== undefined) {
      return { data: this.rpcResponses.finance_summary, error: null };
    }
    throw new Error('Unexpected fixture RPC');
  }
  private async consumeDeleteConfirmation(args: Row): Promise<Result> {
    if (this.rpcError) return { data: null, error: this.rpcError };
    // This fixture derives outcomes from stored state. SQL clock, concurrency and rollback proof is separate.
    if ((args.p_decision !== 'confirm' && args.p_decision !== 'cancel') ||
        typeof args.p_chat_id !== 'string' || typeof args.p_requester_phone !== 'string' ||
        typeof args.p_confirmation_message_id !== 'string' ||
        !this.tables.accounts.some((row) => row.id === args.p_account_id && row.is_active === true && row.wa_chat_id === args.p_chat_id)) {
      return { data: 'forbidden', error: null };
    }
    const pending = this.tables.pending_actions.find((row) => row.id === args.p_pending_id);
    if (!pending) return { data: 'already_consumed', error: null };
    if (pending.action !== 'DELETE' || pending.account_id !== args.p_account_id || pending.wa_chat_id !== args.p_chat_id ||
        pending.requested_by_phone !== args.p_requester_phone || pending.confirmation_message_id == null ||
        pending.confirmation_message_id !== args.p_confirmation_message_id) {
      return { data: 'forbidden', error: null };
    }
    if (Date.parse(String(pending.expires_at)) <= this.clock) {
      this.tables.pending_actions=this.tables.pending_actions.filter(row=>row.id!==pending.id);
      return {data:'expired',error:null};
    }
    const target=this.tables.transactions.find(row=>row.id===pending.transaction_id && row.account_id===pending.account_id);
    this.tables.pending_actions=this.tables.pending_actions.filter(row=>row.id!==pending.id);
    if (!target) return {data:'target_missing',error:null};
    const outcome=args.p_decision==='cancel'?'cancelled':'deleted';
    if (outcome==='deleted') {
      this.tables.transactions=this.tables.transactions.filter(row=>row!==target);
      this.tables.pending_actions=this.tables.pending_actions.filter(row=>row.transaction_id!==target.id);
    }
    return { data: outcome, error: null };
  }
}
class Query implements PromiseLike<Result> {
  private mode: Mode = 'read'; private filters: ((row: Row) => boolean)[] = [];
  private values: Row = {}; private conflict: string[] = []; private one = false;
  private cached: Promise<Result> | null = null;
  private limitValue: number | null = null;
  private columns = '*';
  private ordering: { column: string; ascending: boolean }[] = [];
  constructor(private db: SecurityDb, private table: string) {}
  select(columns = '*'): this { this.columns = columns; return this; }
  eq(column: string, value: unknown): this {
    this.filters.push((row) => {
      const field = this.field(row, column);
      if (field == null || value == null) return false;
      if (column === 'amount') {
        const left = numericKey(field), right = numericKey(value);
        return left !== null && right !== null && left === right;
      }
      return field === value;
    });
    return this;
  }
  is(column: string, value: null | boolean): this {
    this.filters.push((row) => this.field(row, column) === value); return this;
  }
  in(column: string, values: unknown[]): this { this.filters.push((row) => values.includes(row[column])); return this; }
  gt(column: string, value: string): this { this.filters.push((row) => String(row[column]) > value); return this; }
  gte(column: string, value: string): this { this.filters.push((row) => String(row[column]) >= value); return this; }
  lte(column: string, value: string): this { this.filters.push((row) => String(row[column]) <= value); return this; }
  order(column: string, options: { ascending?: boolean } = {}): this {
    this.ordering.push({ column, ascending: options.ascending ?? true }); return this;
  }
  ilike(column: string, value: string): this {
    const pattern = Array.from(value).map((char) => char === '%' ? '.*' : char === '_' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    const match = new RegExp('^' + pattern + '$', 'i');
    this.filters.push((row) => match.test(String(this.field(row, column)))); return this;
  }
  limit(value: number): this { this.limitValue=value; return this; }
  insert(values: Row): this { this.mode = 'insert'; this.values = values; return this; }
  update(values: Row): this { this.mode = 'update'; this.values = values; return this; }
  delete(): this { this.mode = 'delete'; return this; }
  upsert(values: Row, options: { onConflict: string }): this { this.mode = 'upsert'; this.values = values; this.conflict = options.onConflict.split(','); return this; }
  single(): Promise<Result> { this.one = true; return this.execute(); }
  maybeSingle(): Promise<Result> { this.one = true; return this.execute(); }
  then<T1 = Result, T2 = never>(fulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    rejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null): Promise<T1 | T2> {
    return this.execute().then(fulfilled, rejected);
  }
  private execute(): Promise<Result> {
    if (this.cached) return this.cached;
    this.cached = Promise.resolve(this.resolve()); return this.cached;
  }
  private field(row: Row, column: string): unknown {
    if (column === 'categories.name') {
      return this.db.tables.categories.find((category) => category.id === row.category_id)?.name;
    }
    return row[column];
  }
  private project(row: Row): Row {
    const result: Row = {};
    for (const column of this.columns.split(',').map((value) => value.trim())) {
      if (column === '*') Object.assign(result, row);
      else if (column === 'amount::text') result.amount = row.amount == null ? row.amount : String(row.amount);
      else if (column === 'categories(name)' || column === 'categories!inner(name)') {
        const category = this.db.tables.categories.find((item) => item.id === row.category_id);
        result.categories = category ? { name: category.name } : null;
      } else if (column === 'accounts(*)') {
        const account = this.db.tables.accounts.find((item) => item.id === row.account_id);
        result.accounts = account ? { ...account } : null;
      } else result[column] = row[column];
    }
    return result;
  }
  private resolve(): Result {
    const failure = this.db.failures.find((f) => f.table === this.table && f.mode === this.mode);
    if (failure && (failure.skip ?? 0) > 0) failure.skip!--;
    else if (failure) {
      this.db.failures.splice(this.db.failures.indexOf(failure), 1);
      return failure.zero ? { data: this.one ? null : [], error: null } : { data: null, error: { code: failure.code ?? '08006' } };
    }
    if (this.table === 'members' && this.mode === 'upsert' && (this.conflict.length !== 1 || this.conflict[0] !== 'id')) {
      return { data: null, error: { code: '42P10' } };
    }
    const rows = this.db.tables[this.table] ?? [];
    let selected = rows.filter((row) => this.filters.every((f) => f(row)));
    if (this.mode !== 'read') this.db.writes.push({ table: this.table, mode: this.mode });
    if (this.mode === 'insert' || this.mode === 'upsert') {
      const existing = this.mode === 'upsert' ? rows.find((row) => this.conflict.every((key) => row[key] === this.values[key])) : undefined;
      if (existing) { Object.assign(existing, this.values); selected = [existing]; }
      else {
        const id = `80000000-0000-4000-8000-${String(this.db.sequence++).padStart(12, '0')}`;
        if (this.table === 'categories' && rows.some(c=>c.account_id===this.values.account_id && c.type===this.values.type && c.parent_id===(this.values.parent_id ?? null) && c.is_active===true &&
          ['name_id','name_en'].some(key=>typeof c[key]==='string' && typeof this.values[key]==='string' && String(c[key]).trim().toLowerCase()===String(this.values[key]).trim().toLowerCase()))) return {data:null,error:{code:'23505'}};
        const row = {id,...(this.table === 'categories' ? {code:null,parent_id:null,name_id:null,name_en:null,sort_order:0} : {}),...this.values}; rows.push(row); selected = [row];
      }
    } else if (this.mode === 'update') selected.forEach((row) => Object.assign(row, this.values));
    else if (this.mode === 'delete') {
      this.db.tables[this.table] = rows.filter((row) => !selected.includes(row));
      if (this.table === 'transactions') {
        this.db.tables.pending_actions = this.db.tables.pending_actions.filter((pending) =>
          !selected.some((row) => row.id === pending.transaction_id));
      }
    }
    selected.sort((left, right) => {
      for (const order of this.ordering) {
        const comparison = String(this.field(left, order.column) ?? '').localeCompare(String(this.field(right, order.column) ?? ''));
        if (comparison) return order.ascending ? comparison : -comparison;
      }
      return 0;
    });
    if (this.limitValue !== null) selected = selected.slice(0, this.limitValue);
    if (this.one && selected.length > 1) return { data: null, error: { code: 'PGRST116' } };
    const projected = selected.map((row) => this.project(row));
    return { data: this.one ? projected[0] ?? null : projected, error: null };
  }
}
export const accountId = '10000000-0000-4000-8000-000000000001';
export const foreignAccountId = '10000000-0000-4000-8000-000000000002';
export const expenseId = '20000000-0000-4000-8000-000000000001';
export const incomeId = '20000000-0000-4000-8000-000000000002';
export const inactiveId = '20000000-0000-4000-8000-000000000003';
export const foreignCategoryId = '20000000-0000-4000-8000-000000000004';
export const txnId = '30000000-0000-4000-8000-000000000001';
export function seedSecurityDb(): SecurityDb {
  const db = new SecurityDb();
  db.tables.accounts = [{ id: accountId, name: 'Disposable account', type: 'group', wa_chat_id: 'test-group', language: 'en', owner_id: '90000000-0000-4000-8000-000000000001', is_active: true }];
  db.tables.members = [{id:'40000000-0000-4000-8000-000000000001',account_id:accountId,wa_phone:'requester-A',display_name:'A',language_pref:null,user_id:'90000000-0000-4000-8000-000000000001'}];
  db.tables.categories = [
    {id:expenseId,account_id:accountId,code:'expense.other',name_id:'Food',name_en:'Food',parent_id:null,type:'expense',is_custom:false,is_active:true,sort_order:0},
    {id:incomeId,account_id:accountId,code:'income.other',name_id:'Tips',name_en:'Tips',parent_id:null,type:'income',is_custom:false,is_active:true,sort_order:1},
    {id:inactiveId,account_id:accountId,code:null,name_id:'Old food',name_en:null,parent_id:null,type:'expense',is_custom:true,is_active:false,sort_order:2},
    {id:foreignCategoryId,account_id:foreignAccountId,code:null,name_id:'Foreign food',name_en:null,parent_id:null,type:'expense',is_custom:true,is_active:true,sort_order:0},
  ];
  db.tables.transactions = [{ id: txnId, account_id: accountId, amount: '20.00', type: 'expense', description: 'Existing', date: '2026-10-12', category_id: expenseId, wa_bot_message_id: 'old-receipt' }];
  return db;
}
