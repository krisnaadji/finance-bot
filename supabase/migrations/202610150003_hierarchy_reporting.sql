begin;
set local lock_timeout='5s';
do $$ begin
 if pg_catalog.to_regprocedure('bot_private.category_label(text,text,text)') is null or
    pg_catalog.to_regprocedure('public.finance_summary(uuid,date,date)') is null then raise exception 'Hierarchy reporting prerequisites missing'; end if;
end $$;
create function bot_private.category_json(c public.categories) returns jsonb
language sql stable set search_path='' as $$
 select case when c.id is null then null else pg_catalog.jsonb_build_object(
  'id',c.id,'account_id',c.account_id,'code',c.code,'name_id',c.name_id,'name_en',c.name_en,
  'parent_id',c.parent_id,'type',c.type,'is_custom',c.is_custom,'is_active',c.is_active,'sort_order',c.sort_order) end
$$;
create function bot_private.transaction_json(t public.transactions) returns jsonb
language sql stable set search_path='' as $$
 select (pg_catalog.to_jsonb(t)-'amount')||pg_catalog.jsonb_build_object('amount',t.amount::text,
  'categories',bot_private.category_json(c),'parent',bot_private.category_json(p))
 from (select 1) anchor left join public.categories c on c.id=t.category_id and c.account_id=t.account_id and c.type=t.type
 left join public.categories p on p.id=c.parent_id and p.account_id=c.account_id and p.type=c.type and p.parent_id is null
$$;
-- Raises 22023 for invalid filters and 42501 for an inactive account. Consumers map these to JSON codes.
create function bot_private.finance_selection(p_account_id uuid,p_filters jsonb) returns setof public.transactions
language plpgsql stable security invoker set search_path='' as $$
declare v_from date; v_to date; v_type text; v_root uuid; v_child uuid; v_scope text; v_search text;
 r public.categories%rowtype; ch public.categories%rowtype;
begin
 if p_account_id is null or pg_catalog.jsonb_typeof(p_filters) is distinct from 'object' or exists(
  select 1 from pg_catalog.jsonb_object_keys(p_filters) k where k not in ('accountId','from','to','type','categoryId','subcategoryId','categoryScope','search','locale')) then
  raise exception 'Invalid transaction filters' using errcode='22023'; end if;
 if exists(select 1 from pg_catalog.jsonb_each(p_filters) e where pg_catalog.jsonb_typeof(e.value) not in ('string','null')) then
  raise exception 'Invalid filter value type' using errcode='22023'; end if;
 begin
  if p_filters->>'accountId' is not null and (p_filters->>'accountId')::uuid<>p_account_id then raise exception 'Account mismatch' using errcode='22023'; end if;
  v_from=(p_filters->>'from')::date; v_to=(p_filters->>'to')::date;
  v_type=p_filters->>'type'; v_root=(p_filters->>'categoryId')::uuid; v_child=(p_filters->>'subcategoryId')::uuid;
 exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
  raise exception 'Invalid filter syntax' using errcode='22023';
 end;
 if (v_from is not null and (v_from::text<>p_filters->>'from' or v_from<'2000-01-01'::date or v_from>'2100-12-31'::date)) or
    (v_to is not null and (v_to::text<>p_filters->>'to' or v_to<'2000-01-01'::date or v_to>'2100-12-31'::date)) or
    (v_from is not null and v_to is not null and v_from>v_to) or
    (v_type is not null and v_type not in ('income','expense')) or
    (p_filters ? 'locale' and (p_filters->>'locale' is null or p_filters->>'locale' not in ('id','en'))) then
  raise exception 'Invalid filter range/type/locale' using errcode='22023'; end if;
 v_scope=coalesce(p_filters->>'categoryScope','all'); v_search=nullif(p_filters->>'search','');
 if v_scope not in ('all','direct') or (v_child is not null and (v_root is null or v_scope='direct')) or
    (v_root is null and v_scope='direct') then raise exception 'Invalid category scope' using errcode='22023'; end if;
 if not exists(select 1 from public.accounts where id=p_account_id and is_active) then
  raise exception 'Inactive account' using errcode='42501'; end if;
 if v_root is not null then
  select * into r from public.categories where id=v_root and account_id=p_account_id;
  if not found or (v_type is not null and r.type<>v_type) or (r.parent_id is not null and (v_child is not null or v_scope='direct')) then
   raise exception 'Invalid category filter' using errcode='22023'; end if;
 end if;
 if v_child is not null then
  select * into ch from public.categories where id=v_child and account_id=p_account_id and parent_id=v_root and type=r.type;
  if not found then raise exception 'Invalid subcategory filter' using errcode='22023'; end if;
 end if;
 return query select t.* from public.transactions t
 left join public.categories c on c.id=t.category_id and c.account_id=t.account_id and c.type=t.type
 where t.account_id=p_account_id and (v_from is null or t.date>=v_from) and (v_to is null or t.date<=v_to)
  and (v_type is null or t.type=v_type) and (v_search is null or coalesce(t.description,'') ilike '%'||v_search||'%')
  and (v_root is null or c.id is not null and case when v_child is not null then t.category_id=v_child
    when v_scope='direct' or r.parent_id is not null then t.category_id=v_root
    else t.category_id=v_root or c.parent_id=v_root end);
end $$;
create function public.finance_transaction_view(p_account_id uuid,p_filters jsonb,p_page integer,p_page_size integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb; v_offset bigint;
begin
 if p_page is null or p_page<1 or p_page_size is null or p_page_size<1 or p_page_size>99999 then
  return pg_catalog.jsonb_build_object('code','invalid'); end if;
 v_offset=(p_page::bigint-1)*p_page_size::bigint;
 with matching as materialized (select * from bot_private.finance_selection(p_account_id,p_filters)),
 totals as (select count(*) as n,coalesce(sum(amount) filter(where type='income'),0.00) as income,
  coalesce(sum(amount) filter(where type='expense'),0.00) as expense from matching),
 page as (select * from matching order by date desc,created_at desc,id desc offset v_offset limit p_page_size)
 select pg_catalog.jsonb_build_object('total',totals.n,'summary',pg_catalog.jsonb_build_object('income',income::text,'expense',expense::text,'net',(income-expense)::text),
  'rows',coalesce((select pg_catalog.jsonb_agg(bot_private.transaction_json(page) order by date desc,created_at desc,id desc) from page),'[]'::jsonb)) into result from totals;
 return result;
exception when invalid_parameter_value then return pg_catalog.jsonb_build_object('code','invalid');
 when insufficient_privilege then return pg_catalog.jsonb_build_object('code','forbidden');
end $$;
create or replace function public.finance_summary(p_account_id uuid,p_from date,p_to date) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 if p_from is null or p_to is null then return pg_catalog.jsonb_build_object('code','invalid'); end if;
 with matching as materialized (
  select t.*,c.id as safe_category_id,coalesce(c.parent_id,c.id) as root_id,
   bot_private.category_json(c) as category_json,bot_private.category_json(p) as parent_json
  from bot_private.finance_selection(p_account_id,pg_catalog.jsonb_build_object('from',p_from::text,'to',p_to::text)) t
  left join public.categories c on c.id=t.category_id and c.account_id=t.account_id and c.type=t.type
  left join public.categories p on p.id=c.parent_id and p.account_id=c.account_id and p.type=c.type and p.parent_id is null
 ), totals as (
  select coalesce(sum(amount) filter(where type='income'),0.00) as income,coalesce(sum(amount) filter(where type='expense'),0.00) as expense from matching
 ), roots as (select root_id,sum(amount) as amount from matching where type='expense' group by root_id),
 details as (select root_id,safe_category_id,sum(amount) as amount from matching where type='expense' group by root_id,safe_category_id),
 monthly as (
  select month_start,coalesce(sum(m.amount) filter(where m.type='income'),0.00) as income,coalesce(sum(m.amount) filter(where m.type='expense'),0.00) as expense
  from pg_catalog.generate_series(pg_catalog.date_trunc('month',p_from)::date,pg_catalog.date_trunc('month',p_to)::date,interval '1 month') month_start
  left join matching m on m.date>=month_start::date and m.date<(month_start+interval '1 month')::date group by month_start
 ), top_expenses as (select * from matching where type='expense' order by amount desc,date desc,id asc limit 5),
 top_incomes as (select * from matching where type='income' order by amount desc,date desc,id asc limit 5)
 select pg_catalog.jsonb_build_object('income',income::text,'expense',expense::text,'net',(income-expense)::text,
  'categories',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',r.root_id,'name',coalesce(bot_private.category_label(c.name_id,c.name_en,'id'),'Other'),'name_id',c.name_id,'name_en',c.name_en,'amount',r.amount::text)
   order by r.amount desc,r.root_id nulls last) from roots r left join public.categories c on c.id=r.root_id and c.account_id=p_account_id),'[]'::jsonb),
  'spendingByCategoryId',coalesce((select pg_catalog.jsonb_object_agg(root_id::text,amount::text) from roots where root_id is not null),'{}'::jsonb),
  'categoryDetails',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('parentId',root_id,'categoryId',safe_category_id,'amount',amount::text)
   order by root_id nulls last,safe_category_id nulls last) from details),'[]'::jsonb),
  'byMonth',coalesce((select pg_catalog.jsonb_object_agg(pg_catalog.to_char(month_start,'YYYY-MM'),pg_catalog.jsonb_build_object('income',income::text,'expense',expense::text)) from monthly),'{}'::jsonb),
  'topExpenses',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',id,'date',date::text,'description',coalesce(description,''),'amount',amount::text,'category',coalesce(bot_private.category_label(category_json->>'name_id',category_json->>'name_en','id'),'—'),'categories',category_json,'parent',parent_json) order by amount desc,date desc,id asc) from top_expenses),'[]'::jsonb),
  'topIncomes',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',id,'date',date::text,'description',coalesce(description,''),'amount',amount::text,'category',coalesce(bot_private.category_label(category_json->>'name_id',category_json->>'name_en','id'),'—'),'categories',category_json,'parent',parent_json) order by amount desc,date desc,id asc) from top_incomes),'[]'::jsonb)
 ) into result from totals;
 return result;
exception when invalid_parameter_value then return pg_catalog.jsonb_build_object('code','invalid');
 when insufficient_privilege then return pg_catalog.jsonb_build_object('code','forbidden');
end $$;
create or replace function public.finance_budget_spending(p_account_id uuid,p_from date,p_to date) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 if p_from is null or p_to is null then return pg_catalog.jsonb_build_object('code','invalid'); end if;
 select pg_catalog.jsonb_build_object('spendingByCategoryId',coalesce(pg_catalog.jsonb_object_agg(root_id::text,amount::text),'{}'::jsonb)) into result
 from (select coalesce(c.parent_id,c.id) as root_id,sum(t.amount) as amount
  from bot_private.finance_selection(p_account_id,pg_catalog.jsonb_build_object('from',p_from::text,'to',p_to::text,'type','expense')) t
  join public.categories c on c.id=t.category_id and c.account_id=t.account_id and c.type=t.type group by coalesce(c.parent_id,c.id)) spending;
 return result;
exception when invalid_parameter_value then return pg_catalog.jsonb_build_object('code','invalid');
 when insufficient_privilege then return pg_catalog.jsonb_build_object('code','forbidden');
end $$;
revoke all on function bot_private.category_json(public.categories),bot_private.transaction_json(public.transactions),bot_private.finance_selection(uuid,jsonb),
 public.finance_transaction_view(uuid,jsonb,integer,integer) from public,anon,authenticated;
grant execute on function bot_private.category_json(public.categories),bot_private.transaction_json(public.transactions),bot_private.finance_selection(uuid,jsonb),
 public.finance_transaction_view(uuid,jsonb,integer,integer) to service_role;
commit;
