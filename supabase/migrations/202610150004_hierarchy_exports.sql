begin;
set local lock_timeout='5s';
do $$ begin
 if pg_catalog.to_regprocedure('bot_private.finance_selection(uuid,jsonb)') is null or
    pg_catalog.to_regclass('public.finance_export_rows') is null then raise exception 'Hierarchy export prerequisites missing'; end if;
end $$;
alter table public.finance_export_rows add column subcategory text not null default '';
alter table public.finance_export_snapshots add column format_version smallint not null default 1 check(format_version in (1,2));
create or replace function public.start_finance_export(p_user_id uuid,p_filters jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_account uuid; v_id uuid=pg_catalog.gen_random_uuid(); v_now timestamptz=pg_catalog.clock_timestamp();
 v_expiry timestamptz; v_filters jsonb; v_locale text; result jsonb;
begin
 if p_user_id is null or pg_catalog.jsonb_typeof(p_filters) is distinct from 'object' then return pg_catalog.jsonb_build_object('code','invalid'); end if;
 begin v_account=(p_filters->>'accountId')::uuid;
 exception when invalid_text_representation then return pg_catalog.jsonb_build_object('code','invalid'); end;
 if v_account is null then return pg_catalog.jsonb_build_object('code','invalid'); end if;
 if not exists(select 1 from public.accounts a where a.id=v_account and a.is_active and
  (a.owner_id=p_user_id or exists(select 1 from public.members m where m.account_id=a.id and m.user_id=p_user_id))) then
  return pg_catalog.jsonb_build_object('code','forbidden'); end if;
 v_locale=case when p_filters ? 'locale' then p_filters->>'locale' else 'id' end;
 v_filters=p_filters||pg_catalog.jsonb_build_object('locale',v_locale,'categoryScope',coalesce(p_filters->>'categoryScope','all'));
 v_expiry=v_now+interval '15 minutes';
 with candidates as materialized (
  select t.id,t.date,t.created_at,coalesce(t.description,'') as description,t.type,t.amount,
   coalesce(bot_private.category_label(r.name_id,r.name_en,v_locale),'') as category,
   case when c.parent_id is null then '' else coalesce(bot_private.category_label(c.name_id,c.name_en,v_locale),'') end as subcategory
  from bot_private.finance_selection(v_account,v_filters) t
  left join public.categories c on c.id=t.category_id and c.account_id=t.account_id and c.type=t.type
  left join public.categories r on r.id=coalesce(c.parent_id,c.id) and r.account_id=t.account_id and r.type=t.type and r.parent_id is null
  limit 100000
 ), stats as (
  -- Includes quotes, doubled quotes, commas, CRLF and a conservative formula prefix byte on each user-controlled cell.
  select count(*) as n,pg_catalog.octet_length(E'"Date","Description","Category","Subcategory","Type","Amount"\r\n')+coalesce(sum(
   pg_catalog.octet_length(date::text)+2+pg_catalog.octet_length(amount::text)+2+pg_catalog.octet_length(type)+2+
   pg_catalog.octet_length(pg_catalog.replace(description,'"','""'))+3+
   pg_catalog.octet_length(pg_catalog.replace(category,'"','""'))+3+
   pg_catalog.octet_length(pg_catalog.replace(subcategory,'"','""'))+3+7),0) as bytes from candidates
 ), created as (
  insert into public.finance_export_snapshots(id,user_id,account_id,filters,row_count,created_at,expires_at,format_version)
  select v_id,p_user_id,v_account,v_filters,n,v_now,v_expiry,2 from stats where n<=99999 and bytes<=33554432 returning id
 ), inserted as (
  insert into public.finance_export_rows(snapshot_id,ordinal,transaction_id,date,created_at,description,category,subcategory,type,amount)
  select created.id,pg_catalog.row_number() over(order by candidates.date desc,candidates.created_at desc,candidates.id desc),
   candidates.id,candidates.date,candidates.created_at,candidates.description,candidates.category,candidates.subcategory,candidates.type,candidates.amount
  from candidates cross join created returning ordinal
 ) select case when n>99999 or bytes>33554432 then pg_catalog.jsonb_build_object('code','limit') else
  pg_catalog.jsonb_build_object('id',v_id,'count',(select count(*) from inserted),'expiresAt',v_expiry,'pageSize',500) end into result from stats;
 return result;
exception when invalid_parameter_value then return pg_catalog.jsonb_build_object('code','invalid');
 when insufficient_privilege then return pg_catalog.jsonb_build_object('code','forbidden');
end $$;
create or replace function public.read_finance_export(p_user_id uuid,p_export_id uuid,p_after bigint,p_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_snapshot public.finance_export_snapshots%rowtype;
 v_rows jsonb;
begin
 if p_user_id is null or p_export_id is null or p_after is null or p_after<0 or p_limit is null or p_limit<1 or p_limit>500 then
  return pg_catalog.jsonb_build_object('code','invalid');
 end if;
 select * into v_snapshot from public.finance_export_snapshots where id=p_export_id and user_id=p_user_id;
 if not found then return pg_catalog.jsonb_build_object('code','not_found'); end if;
 if not exists(
  select 1 from public.accounts a
  where a.id=v_snapshot.account_id and a.is_active and
   (a.owner_id=p_user_id or exists(select 1 from public.members m where m.account_id=a.id and m.user_id=p_user_id))
 ) then return pg_catalog.jsonb_build_object('code','forbidden'); end if;
 if v_snapshot.expires_at<=pg_catalog.clock_timestamp() then
  return pg_catalog.jsonb_build_object('code','expired');
 end if;
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'ordinal',rows.ordinal,'transactionId',rows.transaction_id,'date',rows.date::text,
  'description',rows.description,'category',rows.category,'subcategory',rows.subcategory,'type',rows.type,'amount',rows.amount::text
 ) order by rows.ordinal),'[]'::jsonb) into v_rows
 from (
  select r.* from public.finance_export_rows r
  where r.snapshot_id=v_snapshot.id and r.ordinal>p_after
  order by r.ordinal limit p_limit
 ) rows;
 return pg_catalog.jsonb_build_object('rows',v_rows);
end $$;


commit;
