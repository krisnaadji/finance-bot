begin;
set local lock_timeout='5s';

do $$ begin
 if pg_catalog.to_regclass('auth.users') is null or
    pg_catalog.to_regprocedure('public.create_finance_account(uuid,uuid,text,text,text)') is null or
    pg_catalog.to_regprocedure('public.redeem_finance_invite(uuid,text,text)') is null then
  raise exception 'Account Auth access prerequisites missing';
 end if;
end $$;

-- The invoker RPCs check user existence; no other Auth field is required.
grant usage on schema auth to service_role;
grant select(id) on auth.users to service_role;

-- PostgreSQL requires UPDATE privilege for the RPCs' SELECT FOR UPDATE locks.
grant update on public.account_creation_operations,public.invite_redemptions to service_role;

do $$ begin
 if not pg_catalog.has_schema_privilege('service_role','auth','USAGE') or
    not pg_catalog.has_column_privilege('service_role','auth.users','id','SELECT') or
    not pg_catalog.has_table_privilege('service_role','public.account_creation_operations','UPDATE') or
    not pg_catalog.has_table_privilege('service_role','public.invite_redemptions','UPDATE') then
  raise exception 'Account operation access grants failed; use authorized table owners';
 end if;
end $$;
commit;
