begin;
set local lock_timeout = '5s';
lock table public.pending_actions in access exclusive mode;

delete from public.pending_actions
where action='DELETE' and (
 expires_at <= clock_timestamp() or account_id is null or transaction_id is null
 or requested_by_phone is null or wa_chat_id is null
);

-- Only inspected account-wide uniqueness is obsolete; reject any unreviewed conflict.
do $$
declare v_constraint record; v_index record;
begin
 for v_constraint in
  select c.conname from pg_catalog.pg_constraint c
  where c.conrelid='public.pending_actions'::regclass and c.contype='u'
   and (select array_agg(a.attname::text order by a.attname)
        from unnest(c.conkey) as k(attnum)
        join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)
       in (array['account_id']::text[], array['account_id','action']::text[])
 loop
  execute pg_catalog.format('alter table public.pending_actions drop constraint %I', v_constraint.conname);
 end loop;
 for v_index in
  select i.indexrelid::regclass as index_name from pg_catalog.pg_index i
  where i.indrelid='public.pending_actions'::regclass and i.indisunique and not i.indisprimary
   and not exists(select 1 from pg_catalog.pg_constraint c where c.conindid=i.indexrelid)
   and i.indexprs is null and i.indpred is null
   and (select array_agg(a.attname::text order by a.attname)
        from unnest(i.indkey::smallint[]) as k(attnum)
        join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum)
       in (array['account_id']::text[], array['account_id','action']::text[])
 loop
  execute pg_catalog.format('drop index %s', v_index.index_name);
 end loop;
end $$;

alter table public.pending_actions
 add constraint pending_delete_bound_fields check (
  action <> 'DELETE' or (
   account_id is not null and transaction_id is not null
   and requested_by_phone is not null and requested_by_phone <> ''
   and wa_chat_id is not null and wa_chat_id <> ''
   and expires_at is not null
  )
 );
alter table public.pending_actions
 add constraint pending_sender_chat_unique unique(account_id,wa_chat_id,requested_by_phone);
commit;
