begin;
set local lock_timeout='5s';
do $$ begin
 if pg_catalog.to_regclass('public.accounts') is null or
    pg_catalog.to_regclass('public.categories') is null or
    pg_catalog.to_regclass('public.members') is null or
    pg_catalog.to_regclass('public.link_codes') is null or
    pg_catalog.to_regclass('public.invite_tokens') is null or
    pg_catalog.to_regprocedure('public.seed_categories(uuid)') is null then
  raise exception 'Account operation prerequisites missing';
 end if;
end $$;

create table public.account_creation_operations (
 owner_id uuid not null references auth.users(id),
 operation_id uuid not null,
 payload jsonb not null,
 account_id uuid not null references public.accounts(id),
 created_at timestamptz not null default pg_catalog.clock_timestamp(),
 primary key(owner_id,operation_id)
);
alter table public.account_creation_operations enable row level security;
create policy account_creation_operations_service on public.account_creation_operations
 to service_role using(true) with check(true);
revoke all on public.account_creation_operations from public,anon,authenticated;
grant select,insert on public.account_creation_operations to service_role;

create table public.invite_redemptions (
 token_id uuid primary key references public.invite_tokens(id),
 user_id uuid not null references auth.users(id),
 member_id uuid not null references public.members(id),
 redeemed_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table public.invite_redemptions enable row level security;
create policy invite_redemptions_service on public.invite_redemptions
 to service_role using(true) with check(true);
revoke all on public.invite_redemptions from public,anon,authenticated;
grant select,insert on public.invite_redemptions to service_role;

create function public.create_finance_account(
 p_user_id uuid,p_operation_id uuid,p_name text,p_type text,p_display_name text
) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_payload jsonb; v_existing_payload jsonb; v_account public.accounts%rowtype; v_account_id uuid;
begin
 if p_user_id is null or p_operation_id is null or p_name is null or p_type is null or
    pg_catalog.length(pg_catalog.btrim(p_name))=0 or pg_catalog.length(pg_catalog.btrim(p_name))>120 or
    (p_display_name is not null and (pg_catalog.length(pg_catalog.btrim(p_display_name))=0 or
     pg_catalog.length(pg_catalog.btrim(p_display_name))>120)) or p_type not in ('personal','group') then
  return pg_catalog.jsonb_build_object('code','invalid');
 end if;
 if not exists(select 1 from auth.users where id=p_user_id) then
  return pg_catalog.jsonb_build_object('code','forbidden');
 end if;
 v_payload=pg_catalog.jsonb_build_object('name',pg_catalog.btrim(p_name),'type',p_type,
  'displayName',case when p_display_name is null then null else pg_catalog.btrim(p_display_name) end);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':'||p_operation_id::text,0));
 select payload,account_id into v_existing_payload,v_account_id from public.account_creation_operations
  where owner_id=p_user_id and operation_id=p_operation_id for update;
 if found then
  if v_existing_payload is distinct from pg_catalog.jsonb_build_object('name',pg_catalog.btrim(p_name),'type',p_type,
    'displayName',case when p_display_name is null then null else pg_catalog.btrim(p_display_name) end) then
   return pg_catalog.jsonb_build_object('code','conflict');
  end if;
  select * into v_account from public.accounts where id=v_account_id;
  if not found then return pg_catalog.jsonb_build_object('code','conflict'); end if;
  return pg_catalog.jsonb_build_object('code','accepted','account',pg_catalog.to_jsonb(v_account));
 end if;
 insert into public.accounts(name,type,owner_id) values(pg_catalog.btrim(p_name),p_type,p_user_id)
  returning * into v_account;
 insert into public.members(account_id,user_id,role,display_name)
  values(v_account.id,p_user_id,'owner',case when p_display_name is null then null else pg_catalog.btrim(p_display_name) end);
 perform public.seed_categories(v_account.id);
 insert into public.account_creation_operations(owner_id,operation_id,payload,account_id)
  values(p_user_id,p_operation_id,v_payload,v_account.id);
 return pg_catalog.jsonb_build_object('code','accepted','account',pg_catalog.to_jsonb(v_account));
end $$;

create function public.replace_finance_link_code(
 p_user_id uuid,p_account_id uuid,p_code text
) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_account public.accounts%rowtype; v_code_id uuid; v_expiry timestamptz;
begin
 if p_user_id is null or p_account_id is null or p_code is null or
    p_code !~ '^[A-Za-z0-9_-]{1,128}$' then
  return pg_catalog.jsonb_build_object('code','invalid');
 end if;
 select * into v_account from public.accounts where id=p_account_id and owner_id=p_user_id for update;
 if not found or not v_account.is_active then return pg_catalog.jsonb_build_object('code','forbidden'); end if;
 perform id from public.link_codes where account_id=p_account_id order by id for update;
 v_expiry=pg_catalog.clock_timestamp()+interval '15 minutes';
 begin
  insert into public.link_codes(account_id,code,used,expires_at)
   values(p_account_id,p_code,false,v_expiry) returning id into v_code_id;
 exception when unique_violation then
  return pg_catalog.jsonb_build_object('code','collision');
 end;
 update public.link_codes set used=true where account_id=p_account_id and id<>v_code_id and not used;
 return pg_catalog.jsonb_build_object('code','accepted','linkCode',pg_catalog.jsonb_build_object(
  'code',p_code,'expiresAt',v_expiry));
end $$;

create function public.redeem_finance_invite(
 p_user_id uuid,p_token text,p_display_name text
) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_account_id uuid; v_account public.accounts%rowtype; v_token public.invite_tokens%rowtype;
 v_redemption public.invite_redemptions%rowtype; v_member public.members%rowtype;
begin
 if p_user_id is null or p_token is null or pg_catalog.length(p_token)=0 or
    (p_display_name is not null and (pg_catalog.length(pg_catalog.btrim(p_display_name))=0 or
     pg_catalog.length(pg_catalog.btrim(p_display_name))>120)) then
  return pg_catalog.jsonb_build_object('code','invalid');
 end if;
 select account_id into v_account_id from public.invite_tokens where token=p_token;
 if not found then return pg_catalog.jsonb_build_object('code','expired'); end if;
 select * into v_account from public.accounts where id=v_account_id for update;
 if not found or not v_account.is_active then return pg_catalog.jsonb_build_object('code','forbidden'); end if;
 select * into v_token from public.invite_tokens where token=p_token and account_id=v_account_id for update;
 if not found then return pg_catalog.jsonb_build_object('code','expired'); end if;
 if v_token.used then
  select * into v_redemption from public.invite_redemptions where token_id=v_token.id for update;
  if found and v_redemption.user_id=p_user_id then
   return pg_catalog.jsonb_build_object('code','accepted','accountId',v_account.id,'accountName',v_account.name);
  end if;
  return pg_catalog.jsonb_build_object('code','conflict');
 end if;
 if v_token.expires_at<=pg_catalog.clock_timestamp() then return pg_catalog.jsonb_build_object('code','expired'); end if;
 if not exists(select 1 from auth.users where id=p_user_id) then return pg_catalog.jsonb_build_object('code','forbidden'); end if;
 select * into v_member from public.members where account_id=v_account.id and user_id=p_user_id for update;
 if not found then
  insert into public.members(account_id,user_id,role,display_name)
   values(v_account.id,p_user_id,'member',case when p_display_name is null then null else pg_catalog.btrim(p_display_name) end) returning * into v_member;
 end if;
 insert into public.invite_redemptions(token_id,user_id,member_id) values(v_token.id,p_user_id,v_member.id);
 update public.invite_tokens set used=true where id=v_token.id and not used;
 return pg_catalog.jsonb_build_object('code','accepted','accountId',v_account.id,'accountName',v_account.name);
end $$;

revoke all on function public.create_finance_account(uuid,uuid,text,text,text),
 public.replace_finance_link_code(uuid,uuid,text),public.redeem_finance_invite(uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.create_finance_account(uuid,uuid,text,text,text),
 public.replace_finance_link_code(uuid,uuid,text),public.redeem_finance_invite(uuid,text,text)
 to service_role;
commit;
