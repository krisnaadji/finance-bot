begin;
set local lock_timeout='5s';
do $$ begin
 if pg_catalog.to_regclass('public.accounts') is null or
    pg_catalog.to_regclass('public.transactions') is null or
    pg_catalog.to_regclass('public.categories') is null then
  raise exception 'Exact reporting prerequisites missing';
 end if;
end $$;
do $$ begin
 if exists (
  select 1 from (values
   ('accounts','id','uuid'),('accounts','is_active','boolean'),
   ('transactions','id','uuid'),('transactions','account_id','uuid'),('transactions','category_id','uuid'),
   ('transactions','amount','numeric'),('transactions','type','text'),('transactions','description','text'),
   ('transactions','date','date'),('categories','id','uuid'),('categories','name','text')
  ) required(table_name,column_name,data_type)
  where not exists (
   select 1 from information_schema.columns c
   where c.table_schema='public' and c.table_name=required.table_name
    and c.column_name=required.column_name and c.data_type=required.data_type
  )
 ) then
  raise exception 'Exact reporting prerequisite column shape mismatch';
 end if;
end $$;

create function public.finance_summary(p_account_id uuid,p_from date,p_to date) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 if p_account_id is null or p_from is null or p_to is null or p_from>p_to then
  return pg_catalog.jsonb_build_object('code','invalid');
 end if;
 if not exists(select 1 from public.accounts where id=p_account_id and is_active) then
  return pg_catalog.jsonb_build_object('code','forbidden');
 end if;
 with matching as materialized (
  select t.id,t.category_id,t.amount,t.type,t.description,t.date,c.name as category_name
  from public.transactions t left join public.categories c on c.id=t.category_id and c.account_id=t.account_id
  where t.account_id=p_account_id and t.date between p_from and p_to
 ), totals as (
  select coalesce(sum(amount) filter(where type='income'),0.00) as income,
         coalesce(sum(amount) filter(where type='expense'),0.00) as expense
  from matching
 ), categories as (
  select category_id,coalesce(category_name,'Other') as name,sum(amount) as amount
  from matching where type='expense' group by category_id,category_name
 ), monthly as (
  select month_start::date as month_start,
   coalesce(sum(m.amount) filter(where m.type='income'),0.00) as income,
   coalesce(sum(m.amount) filter(where m.type='expense'),0.00) as expense
  from pg_catalog.generate_series(
    pg_catalog.date_trunc('month',p_from)::date,
    pg_catalog.date_trunc('month',p_to)::date,
    interval '1 month') month_start
  left join matching m on m.date>=month_start::date and m.date<(month_start+interval '1 month')::date
  group by month_start
 ), top_expenses as (
  select id,date,description,amount,coalesce(category_name,'—') as category
  from matching where type='expense' order by amount desc,date desc,id asc limit 5
 ), top_incomes as (
  select id,date,description,amount,coalesce(category_name,'—') as category
  from matching where type='income' order by amount desc,date desc,id asc limit 5
 )
 select pg_catalog.jsonb_build_object(
  'income',totals.income::text,
  'expense',totals.expense::text,
  'net',(totals.income-totals.expense)::text,
  'categories',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',category_id,'name',name,'amount',amount::text) order by amount desc,category_id asc nulls last)
    from categories),'[]'::jsonb),
  'spendingByCategoryId',coalesce((select pg_catalog.jsonb_object_agg(category_id::text,amount::text)
    from categories where category_id is not null),'{}'::jsonb),
  'byMonth',coalesce((select pg_catalog.jsonb_object_agg(pg_catalog.to_char(month_start,'YYYY-MM'),
    pg_catalog.jsonb_build_object('income',income::text,'expense',expense::text) order by month_start)
    from monthly),'{}'::jsonb),
  'topExpenses',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',id,'date',date::text,'description',coalesce(description,''),'amount',amount::text,'category',category)
    order by amount desc,date desc,id asc) from top_expenses),'[]'::jsonb),
  'topIncomes',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',id,'date',date::text,'description',coalesce(description,''),'amount',amount::text,'category',category)
    order by amount desc,date desc,id asc) from top_incomes),'[]'::jsonb)
 ) into result from totals;
 return result;
end $$;

create function public.finance_budget_spending(p_account_id uuid,p_from date,p_to date) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 if p_account_id is null or p_from is null or p_to is null or p_from>p_to then
  return pg_catalog.jsonb_build_object('code','invalid');
 end if;
 if not exists(select 1 from public.accounts where id=p_account_id and is_active) then
  return pg_catalog.jsonb_build_object('code','forbidden');
 end if;
 select pg_catalog.jsonb_build_object('spendingByCategoryId',coalesce(
  pg_catalog.jsonb_object_agg(category_id::text,amount::text),'{}'::jsonb)) into result
 from (
  select category_id,sum(amount) as amount from public.transactions
  where account_id=p_account_id and type='expense' and category_id is not null
    and date between p_from and p_to
  group by category_id
 ) spending;
 return result;
end $$;

revoke all on function public.finance_summary(uuid,date,date),
 public.finance_budget_spending(uuid,date,date) from public,anon,authenticated;
grant execute on function public.finance_summary(uuid,date,date),
 public.finance_budget_spending(uuid,date,date) to service_role;
commit;
