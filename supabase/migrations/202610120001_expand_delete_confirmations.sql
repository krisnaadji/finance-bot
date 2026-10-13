begin;
set local lock_timeout = '5s';
alter table public.pending_actions
 add column if not exists requested_by_phone text,
 add column if not exists wa_chat_id text,
 add column if not exists confirmation_message_id text;

do $$
declare v_fk record; v_update text;
begin
 select c.* into strict v_fk from pg_catalog.pg_constraint c
 where c.conrelid='public.pending_actions'::regclass and c.contype='f'
   and c.confrelid='public.transactions'::regclass
   and c.conkey=array[(select attnum from pg_catalog.pg_attribute
     where attrelid=c.conrelid and attname='transaction_id')]::smallint[]
   and c.confkey=array[(select attnum from pg_catalog.pg_attribute
     where attrelid=c.confrelid and attname='id')]::smallint[];
 if not v_fk.convalidated or v_fk.confmatchtype<>'s' then
   raise exception 'Review the pending transaction FK before migration';
 end if;
 if v_fk.confdeltype<>'c' then
   v_update=case v_fk.confupdtype
     when 'a' then 'no action' when 'r' then 'restrict' when 'c' then 'cascade'
     when 'n' then 'set null' when 'd' then 'set default' end;
   if v_update is null then raise exception 'Unsupported FK update action'; end if;
   execute pg_catalog.format('alter table public.pending_actions drop constraint %I',v_fk.conname);
   execute pg_catalog.format(
     'alter table public.pending_actions add constraint %I foreign key(transaction_id) references public.transactions(id) on update %s on delete cascade %s initially %s',
     v_fk.conname,v_update,
     case when v_fk.condeferrable then 'deferrable' else 'not deferrable' end,
     case when v_fk.condeferred then 'deferred' else 'immediate' end);
 end if;
end $$;

create or replace function public.consume_delete_confirmation(
 p_pending_id uuid, p_account_id uuid, p_chat_id text, p_requester_phone text,
 p_confirmation_message_id text, p_decision text
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
 v_pending public.pending_actions%rowtype;
 v_transaction_id uuid;
begin
 if p_decision not in ('confirm','cancel') or p_decision is null then
  return 'forbidden';
 end if;
 if p_chat_id is null or p_requester_phone is null or p_confirmation_message_id is null then
  return 'forbidden';
 end if;
 perform 1 from public.accounts a
 where a.id=p_account_id and a.is_active=true and a.wa_chat_id=p_chat_id
 for update;
 if not found then return 'forbidden'; end if;

 select p.* into v_pending from public.pending_actions p
 where p.id=p_pending_id for update;
 if not found then return 'already_consumed'; end if;
 if v_pending.account_id is distinct from p_account_id
    or v_pending.action is distinct from 'DELETE'
    or v_pending.wa_chat_id is distinct from p_chat_id
    or v_pending.requested_by_phone is distinct from p_requester_phone
    or v_pending.confirmation_message_id is distinct from p_confirmation_message_id
    or v_pending.confirmation_message_id is null then
  return 'forbidden';
 end if;
 if v_pending.expires_at <= pg_catalog.clock_timestamp() then
  delete from public.pending_actions where id=v_pending.id;
  return 'expired';
 end if;

 select t.id into v_transaction_id from public.transactions t
 where t.id=v_pending.transaction_id and t.account_id=p_account_id for update;
 if not found then
  delete from public.pending_actions where id=v_pending.id;
  return 'target_missing';
 end if;
 if v_pending.expires_at <= pg_catalog.clock_timestamp() then
  delete from public.pending_actions where id=v_pending.id;
  return 'expired';
 end if;

 delete from public.pending_actions where id=v_pending.id;
 if p_decision='cancel' then return 'cancelled'; end if;
 delete from public.transactions where id=v_transaction_id and account_id=p_account_id;
 if not found then raise exception 'Confirmation target changed during transaction'; end if;
 return 'deleted';
end;
$$;

revoke all on function public.consume_delete_confirmation(uuid,uuid,text,text,text,text) from public;
revoke all on function public.consume_delete_confirmation(uuid,uuid,text,text,text,text) from anon, authenticated;
grant execute on function public.consume_delete_confirmation(uuid,uuid,text,text,text,text) to service_role;
commit;
