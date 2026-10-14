import { sql } from './phase2Db';

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Unsafe fixture identifier');
  return '"' + value + '"';
}
const tables = new Set(['accounts','members','categories','transactions','pending_actions','link_codes','bot_inbox','bot_outbound','bot_help_context','budgets']);
const functions = new Set(['ingest_bot_messages','claim_bot_message','renew_bot_claim','save_bot_command','fail_bot_message',
  'commit_bot_command','lookup_bot_receipt','freeze_bot_reply','claim_bot_outbound','settle_bot_outbound','recover_bot_outbound','load_bot_help_context']);

class ReadQuery implements PromiseLike<{data:Record<string,unknown>[]|null;error:unknown}> {
  private values: unknown[] = [];
  private conditions: string[] = [];
  private ordering: string[] = [];
  private count: number | null = null;
  private joinCategories = false;
  constructor(private table: string) {}
  select(columns: string) { this.joinCategories = columns.includes('categories(') || columns.includes('categories!inner('); return this; }
  private column(name: string) {
    return name === 'categories.name' ? 'c.name' : 't.' + identifier(name);
  }
  private filter(column: string, operator: string, value: unknown) {
    this.values.push(value);
    this.conditions.push(`${this.column(column)} ${operator} $${this.values.length}`);
    return this;
  }
  eq(column: string,value: unknown) { return this.filter(column,'=',value); }
  gte(column: string,value: unknown) { return this.filter(column,'>=',value); }
  lte(column: string,value: unknown) { return this.filter(column,'<=',value); }
  gt(column: string,value: unknown) { return this.filter(column,'>',value); }
  ilike(column: string,value: unknown) { return this.filter(column,'ilike',value); }
  in(column: string,value: unknown[]) {
    this.values.push(value);this.conditions.push(`${this.column(column)} = any($${this.values.length})`);return this;
  }
  order(column: string,options: {ascending?:boolean} = {}) {
    this.ordering.push(`${this.column(column)} ${options.ascending === false ? 'desc' : 'asc'}`);return this;
  }
  limit(count: number) {
    if (!Number.isSafeInteger(count) || count<0) throw new Error('Unsafe fixture row limit');
    this.count=count;return this;
  }
  private async execute() {
    try {
      const projection = this.joinCategories ? ", case when c.id is null then null else jsonb_build_object('name',c.name) end as categories" : '';
      const join = this.joinCategories ? ' left join public.categories c on c.id=t.category_id' : '';
      const where = this.conditions.length ? ' where '+this.conditions.join(' and ') : '';
      const order = this.ordering.length ? ' order by '+this.ordering.join(',') : '';
      const limit = this.count === null ? '' : ' limit '+this.count;
      const data = await sql<Record<string,unknown>>(`select t.*${projection} from public.${identifier(this.table)} t${join}${where}${order}${limit}`,this.values);
      // Supabase serializes date/instant fields rather than exposing pg Date objects.
      const serializable = data.map(row => Object.fromEntries(Object.entries(row).map(([key,value])=>
        [key,value instanceof Date ? (key === 'date' ? value.toISOString().slice(0,10) : value.toISOString()) : value])));
      return { data:serializable,error:null };
    } catch (error) { return {data:null,error}; }
  }
  async maybeSingle() {
    const result=await this.execute();
    if (result.error) return {data:null,error:result.error};
    if (result.data!.length>1) return {data:null,error:{code:'PGRST116'}};
    return {data:result.data![0] ?? null,error:null};
  }
  then<TResult1 = {data:Record<string,unknown>[]|null;error:unknown}, TResult2 = never>(
    onfulfilled?: ((value:{data:Record<string,unknown>[]|null;error:unknown})=>TResult1|PromiseLike<TResult1>)|null,
    onrejected?: ((reason:unknown)=>TResult2|PromiseLike<TResult2>)|null,
  ): Promise<TResult1|TResult2> { return this.execute().then(onfulfilled,onrejected); }
}

export const localSupabase = {
  from(table: string) {
    if (!tables.has(table)) throw new Error('Unsupported fixture table');
    return new ReadQuery(table);
  },
  async rpc(name: string,parameters: Record<string,unknown>) {
    if (!functions.has(name)) throw new Error('Unsupported fixture RPC');
    const entries=Object.entries(parameters);
    try {
      const args=entries.map(([key],i)=>`${identifier(key)} => $${i+1}`).join(',');
      const values=entries.map(([,value])=>value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
      const [row]=await sql<{data:unknown}>(`select public.${identifier(name)}(${args}) as data`,values);
      return {data:row.data,error:null};
    } catch (error) { return {data:null,error}; }
  },
};
