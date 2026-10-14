begin;
set local lock_timeout='5s';

do $$ begin
 if pg_catalog.to_regclass('public.accounts') is null or
    pg_catalog.to_regclass('public.members') is null or
    pg_catalog.to_regclass('public.transactions') is null or
    pg_catalog.to_regclass('public.categories') is null then
  raise exception 'Finance export prerequisites missing';
 end if;
 if exists (
  select 1 from (values
   ('accounts','id','uuid'),('accounts','owner_id','uuid'),('accounts','is_active','boolean'),
   ('members','account_id','uuid'),('members','user_id','uuid'),
   ('transactions','id','uuid'),('transactions','account_id','uuid'),('transactions','category_id','uuid'),
   ('transactions','amount','numeric'),('transactions','type','text'),('transactions','description','text'),
   ('transactions','date','date'),('transactions','created_at','timestamp with time zone'),
   ('categories','id','uuid'),('categories','account_id','uuid'),('categories','name','text')
  ) required(table_name,column_name,data_type)
  where not exists (
   select 1 from information_schema.columns c
   where c.table_schema='public' and c.table_name=required.table_name
    and c.column_name=required.column_name and c.data_type=required.data_type
  )
 ) then
  raise exception 'Finance export prerequisite column shape mismatch';
 end if;
end $$;

create table public.finance_export_snapshots (
 id uuid primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 account_id uuid not null references public.accounts(id) on delete cascade,
 filters jsonb not null,
 row_count bigint not null default 0 check(row_count >= 0),
 page_size integer not null default 500 check(page_size = 500),
 created_at timestamptz not null,
 expires_at timestamptz not null
);
create index finance_export_snapshots_expiry_idx on public.finance_export_snapshots(expires_at,id);

create table public.finance_export_rows (
 snapshot_id uuid not null references public.finance_export_snapshots(id) on delete cascade,
 ordinal bigint not null check(ordinal > 0),
 transaction_id uuid not null,
 date date not null,
 created_at timestamptz not null,
 description text not null,
 category text not null,
 type text not null check(type in ('income','expense')),
 amount numeric not null,
 primary key(snapshot_id,ordinal)
);
alter table public.finance_export_snapshots enable row level security;
alter table public.finance_export_rows enable row level security;
revoke all on public.finance_export_snapshots,public.finance_export_rows from public,anon,authenticated;

create function public.start_finance_export(p_user_id uuid,p_filters jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_account_id uuid;
 v_from date;
 v_to date;
 v_type text;
 v_category_id uuid;
 v_search text;
 v_snapshot_id uuid;
 v_created_at timestamptz := pg_catalog.clock_timestamp();
 v_expires_at timestamptz;
 v_result jsonb;
begin
 if p_user_id is null or p_filters is null or pg_catalog.jsonb_typeof(p_filters)<>'object' then
  return pg_catalog.jsonb_build_object('code','invalid');
 end if;
 begin
  v_account_id := nullif(p_filters->>'accountId','')::uuid;
  v_from := nullif(p_filters->>'from','')::date;
  v_to := nullif(p_filters->>'to','')::date;
  v_type := nullif(p_filters->>'type','');
  v_category_id := nullif(p_filters->>'categoryId','')::uuid;
  v_search := nullif(p_filters->>'search','');
 exception when others then
  return pg_catalog.jsonb_build_object('code','invalid');
 end;
 if v_account_id is null or (v_from is not null and v_to is not null and v_from>v_to) or
    (v_type is not null and v_type not in ('income','expense')) then
  return pg_catalog.jsonb_build_object('code','invalid');
 end if;
 if not exists(
  select 1 from public.accounts a
  where a.id=v_account_id and a.is_active and
   (a.owner_id=p_user_id or exists(select 1 from public.members m where m.account_id=a.id and m.user_id=p_user_id))
 ) then
  return pg_catalog.jsonb_build_object('code','forbidden');
 end if;

 v_snapshot_id := pg_catalog.gen_random_uuid();
 v_expires_at := v_created_at+interval '15 minutes';
 with candidates as materialized (
  select t.id,t.date,t.created_at,coalesce(t.description,'') as description,
   coalesce(c.name,'—') as category,t.type,t.amount
  from public.transactions t
  left join public.categories c on c.id=t.category_id and c.account_id=t.account_id
  where t.account_id=v_account_id
   and (v_from is null or t.date>=v_from)
   and (v_to is null or t.date<=v_to)
   and (v_type is null or t.type=v_type)
   and (v_category_id is null or t.category_id=v_category_id)
   and (v_search is null or coalesce(t.description,'') ilike ('%'||v_search||'%'))
  limit 100000
 ), stats as (
  select pg_catalog.count(*) as row_count,49+coalesce(pg_catalog.sum(
   pg_catalog.octet_length(date::text)+2
   +pg_catalog.octet_length(pg_catalog.replace(description,'"','""'))+3
   +pg_catalog.octet_length(pg_catalog.replace(category,'"','""'))+3
   +pg_catalog.octet_length(pg_catalog.replace(type,'"','""'))+2
   +pg_catalog.octet_length(pg_catalog.replace(amount::text,'"','""'))+2
   +6
  ),0) as csv_bytes
  from candidates
 ), created as (
  insert into public.finance_export_snapshots(id,user_id,account_id,filters,row_count,created_at,expires_at)
  select v_snapshot_id,p_user_id,v_account_id,p_filters,stats.row_count,v_created_at,v_expires_at
  from stats where stats.row_count<=99999 and stats.csv_bytes<=33554432
  returning id
 ), inserted as (
  insert into public.finance_export_rows(snapshot_id,ordinal,transaction_id,date,created_at,description,category,type,amount)
  select created.id,pg_catalog.row_number() over(order by candidates.date desc,candidates.created_at desc,candidates.id desc),
   candidates.id,candidates.date,candidates.created_at,candidates.description,candidates.category,candidates.type,candidates.amount
  from candidates cross join created returning ordinal
 )
 select case when stats.row_count>99999 or stats.csv_bytes>33554432
  then pg_catalog.jsonb_build_object('code','limit')
  else pg_catalog.jsonb_build_object(
   'id',v_snapshot_id,'count',(select pg_catalog.count(*) from inserted),
   'expiresAt',v_expires_at,'pageSize',500)
  end into v_result
 from stats;
 return v_result;
end $$;

create function public.read_finance_export(p_user_id uuid,p_export_id uuid,p_after bigint,p_limit integer) returns jsonb
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
  'description',rows.description,'category',rows.category,'type',rows.type,'amount',rows.amount::text
 ) order by rows.ordinal),'[]'::jsonb) into v_rows
 from (
  select r.* from public.finance_export_rows r
  where r.snapshot_id=v_snapshot.id and r.ordinal>p_after
  order by r.ordinal limit p_limit
 ) rows;
 return pg_catalog.jsonb_build_object('rows',v_rows);
end $$;

create function public.release_finance_export(p_user_id uuid,p_export_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_snapshot public.finance_export_snapshots%rowtype;
begin
 if p_user_id is null or p_export_id is null then return false; end if;
 select * into v_snapshot from public.finance_export_snapshots where id=p_export_id and user_id=p_user_id;
 if not found then return false; end if;
 if not exists(
  select 1 from public.accounts a
  where a.id=v_snapshot.account_id and a.is_active and
   (a.owner_id=p_user_id or exists(select 1 from public.members m where m.account_id=a.id and m.user_id=p_user_id))
 ) then return false; end if;
 delete from public.finance_export_snapshots where id=v_snapshot.id;
 return found;
end $$;

create function public.cleanup_expired_finance_exports(p_limit integer default 1000) returns integer
language plpgsql security definer set search_path='' as $$
declare v_deleted integer;
begin
 if p_limit is null or p_limit<1 or p_limit>10000 then return 0; end if;
 with expired as (
  select id from public.finance_export_snapshots
  where expires_at<=pg_catalog.clock_timestamp()
  order by expires_at,id for update skip locked limit p_limit
 ), deleted as (
  delete from public.finance_export_snapshots s using expired e where s.id=e.id returning s.id
 ) select pg_catalog.count(*) into v_deleted from deleted;
 return v_deleted;
end $$;

revoke all on function public.start_finance_export(uuid,jsonb),
 public.read_finance_export(uuid,uuid,bigint,integer),public.release_finance_export(uuid,uuid),
 public.cleanup_expired_finance_exports(integer) from public,anon,authenticated;
grant execute on function public.start_finance_export(uuid,jsonb),
 public.read_finance_export(uuid,uuid,bigint,integer),public.release_finance_export(uuid,uuid),
 public.cleanup_expired_finance_exports(integer) to service_role;
commit;
